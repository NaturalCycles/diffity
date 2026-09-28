import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Config } from './config.js';
import { WEB_SESSION_MAX_AGE_SECONDS, type Users, type User, type WebSessions } from './users.js';
import { hashPresentedClientSecret, type OAuthProvider } from './oauth.js';
import { describeSession, type ReviewService } from './service.js';
import type { DevLoginProvider, IapLogin } from './login.js';
import { GitHubConnectError, type GitHubAppAccess } from './github-app.js';
import { createMcpServer } from './mcp.js';
import { uiApiRouter } from './ui-api.js';
import { escapeHtml, page } from './html.js';
import { randomToken } from './crypto.js';
import {
  SESSION_COOKIE,
  UI_CONTENT_SECURITY_POLICY,
  pageContentSecurityPolicy,
  parseCookies,
  requireSameOrigin,
  safeNext,
  sessionCookie,
} from './web.js';

export interface AppDeps {
  config: Pick<Config, 'publicUrl' | 'trustProxy'>;
  users: Users;
  webSessions: WebSessions;
  oauth: OAuthProvider;
  service: ReviewService;
  devLogin: DevLoginProvider | null;
  /** When set, identity comes from IAP's header on every request, and there is no login form. */
  iap: IapLogin | null;
  /** When set, users connect GitHub through the App instead of pasting a token. */
  githubApp: GitHubAppAccess | null;
  /** The built review UI; null serves a notice instead of the page. */
  uiDir: string | null;
  version: string;
  /** The SDK's per-IP limits on the OAuth endpoints; tests turn them off. */
  rateLimit?: boolean;
  /** How GitHub access is described on the settings page. */
  gitHubTokenFallback: boolean;
}

interface PendingConsent {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  userId: string;
  expiresAt: number;
}

const CONSENT_TTL_MS = 10 * 60 * 1000;
const IAP_SIGN_OUT = '/_gcp_iap/clear_login_cookie';

function authorizeUrl(client: OAuthClientInformationFull, params: AuthorizationParams): string {
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (params.state !== undefined) {
    query.set('state', params.state);
  }
  if (params.scopes && params.scopes.length > 0) {
    query.set('scope', params.scopes.join(' '));
  }
  if (params.resource) {
    query.set('resource', params.resource.href);
  }
  return `/authorize?${query.toString()}`;
}

/**
 * Where the consent form's redirect may go. A browser applies `form-action` to the redirect that
 * follows a form post as well, so the client's redirect target has to be allowed by name.
 */
function formTargetFor(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : url.protocol;
}

export function createApp(deps: AppDeps): express.Express {
  const { config, users, webSessions, oauth, service } = deps;
  const publicUrl = config.publicUrl;
  const mcpUrl = new URL('/mcp', publicUrl);
  const secureCookies = publicUrl.protocol === 'https:';
  const reviews = service.reviews;
  const pending = new Map<string, PendingConsent>();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  // Read per request, so a UI rebuild shows without restarting the server.
  const indexHtml = (): string | null => {
    const file = deps.uiDir ? join(deps.uiDir, 'index.html') : null;
    return file && existsSync(file) ? readFileSync(file, 'utf-8') : null;
  };

  const cookieToken = (req: Request): string | undefined => parseCookies(req.headers.cookie)[SESSION_COOKIE];

  const userFor = async (req: Request): Promise<User | null> => {
    if (deps.iap) {
      const identity = await deps.iap.identify(req);
      return identity ? users.findOrCreate(identity.email, identity.name) : null;
    }
    const userId = await webSessions.userFor(cookieToken(req));
    return userId ? users.get(userId) : null;
  };

  const sendPage = (res: Response, status: number, title: string, body: string, user: User | null, formTargets: string[] = []) => {
    res.status(status)
      .set('Content-Security-Policy', pageContentSecurityPolicy(formTargets))
      .set('Cache-Control', 'no-store')
      .type('html')
      .send(page({ title, body, user }));
  };

  /** Behind IAP a request without a valid assertion did not come through IAP, so there is nowhere to send it. */
  const notSignedIn = (res: Response, next: string) => {
    if (deps.iap) {
      sendPage(res, 401, 'Not signed in', '<h1>Not signed in</h1><p>This request carried no valid Google sign-in.</p>', null);
      return;
    }
    res.redirect(302, `/login?next=${encodeURIComponent(next)}`);
  };

  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: deps.version });
  });

  if (deps.uiDir) {
    // Build artifacts, the same for everyone; nothing about a review is in them.
    app.use('/assets', express.static(join(deps.uiDir, 'assets'), { index: false, immutable: true, maxAge: '365d' }));
    for (const file of ['favicon.svg', 'brand.svg']) {
      app.get(`/${file}`, (_req, res) => res.sendFile(join(deps.uiDir!, file)));
    }
  }

  oauth.onAuthorize = async (client, params, res) => {
    const user = await userFor(res.req);
    if (!user) {
      notSignedIn(res, authorizeUrl(client, params));
      return;
    }
    const now = Date.now();
    for (const [id, entry] of pending) {
      if (entry.expiresAt < now) {
        pending.delete(id);
      }
    }
    const id = randomToken();
    pending.set(id, { client, params, userId: user.id, expiresAt: now + CONSENT_TTL_MS });
    const clientName = client.client_name?.trim() || 'An MCP client';
    const target = new URL(params.redirectUri);
    sendPage(res, 200, 'Connect an agent', `
      <h1>Connect ${escapeHtml(clientName)}?</h1>
      <p>${escapeHtml(clientName)} will be able to create review sessions and comment on them as
        <strong>${escapeHtml(user.email)}</strong>, with the GitHub access you have given this server.</p>
      <p class="muted">After you allow it, you are sent back to <code>${escapeHtml(target.origin === 'null' ? target.protocol : target.origin)}</code>.</p>
      <form method="post" action="/oauth/consent">
        <input type="hidden" name="request" value="${escapeHtml(id)}">
        <button type="submit" name="decision" value="allow">Allow</button>
        <button type="submit" name="decision" value="deny">Deny</button>
      </form>`, user, [formTargetFor(params.redirectUri)]);
  };

  // The SDK compares client secrets as plain strings; see DbClientsStore for why this hashes them.
  app.use(['/token', '/revoke'], express.urlencoded({ extended: false }), (req, _res, next) => {
    hashPresentedClientSecret(req.body);
    next();
  });

  const limits = deps.rateLimit === false ? { rateLimit: false as const } : {};
  app.use(mcpAuthRouter({
    provider: oauth,
    issuerUrl: publicUrl,
    resourceServerUrl: mcpUrl,
    resourceName: 'diffity',
    authorizationOptions: limits,
    tokenOptions: limits,
    revocationOptions: limits,
    clientRegistrationOptions: limits,
  }));

  // Some clients look for the resource's metadata at the root rather than under its path.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({ resource: mcpUrl.href, authorization_servers: [publicUrl.href], resource_name: 'diffity' });
  });

  const bearer = requireBearerAuth({
    verifier: oauth,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  app.post('/mcp', bearer, express.json({ limit: '12mb' }), async (req, res) => {
    const userId = req.auth?.extra?.userId;
    if (typeof userId !== 'string' || !(await users.get(userId))) {
      res.status(401).json({ error: 'The token belongs to no user' });
      return;
    }
    const server = createMcpServer({
      service,
      userId,
      agentName: (await oauth.clientsStore.clientName(req.auth!.clientId)) ?? 'Claude',
      version: deps.version,
    });
    // Stateless: every request is complete in itself, so nothing is held between them.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          id: null,
        });
      }
    }
  });

  app.all('/mcp', bearer, (_req, res) => {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'This server is stateless: POST only' },
      id: null,
    });
  });

  const sameOrigin = requireSameOrigin(publicUrl);
  const forms = express.urlencoded({ extended: false, limit: '64kb' });

  app.get('/login', async (req, res) => {
    const next = safeNext(req.query.next);
    if (await userFor(req)) {
      res.redirect(302, next);
      return;
    }
    if (deps.iap) {
      notSignedIn(res, next);
      return;
    }
    const form = deps.devLogin
      ? deps.devLogin.renderForm({ action: '/login', next })
      : '<p class="error">No sign-in method is configured on this server.</p>';
    sendPage(res, 200, 'Sign in', `<h1>Sign in</h1>${form}`, null);
  });

  app.post('/login', sameOrigin, forms, async (req, res) => {
    const next = safeNext(req.body?.next);
    if (!deps.devLogin) {
      sendPage(res, 404, 'Sign in', '<p class="error">No sign-in form on this server.</p>', null);
      return;
    }
    const result = await deps.devLogin.handleLogin(req);
    if ('error' in result) {
      sendPage(res, 403, 'Sign in', `<h1>Sign in</h1><p class="error">${escapeHtml(result.error)}</p>${deps.devLogin.renderForm({ action: '/login', next })}`, null);
      return;
    }
    const user = await users.findOrCreate(result.email, result.name);
    const token = await webSessions.create(user.id);
    res.set('Set-Cookie', sessionCookie(token, { secure: secureCookies, maxAgeSeconds: WEB_SESSION_MAX_AGE_SECONDS }));
    res.redirect(303, next);
  });

  app.post('/logout', sameOrigin, async (req, res) => {
    if (deps.iap) {
      res.redirect(303, IAP_SIGN_OUT);
      return;
    }
    await webSessions.destroy(cookieToken(req));
    res.set('Set-Cookie', sessionCookie('', { secure: secureCookies, maxAgeSeconds: 0 }));
    res.redirect(303, '/login');
  });

  app.post('/oauth/consent', sameOrigin, forms, async (req, res) => {
    const user = await userFor(req);
    const id = typeof req.body?.request === 'string' ? req.body.request : '';
    const entry = pending.get(id);
    if (!user || !entry || entry.userId !== user.id || entry.expiresAt < Date.now()) {
      sendPage(res, 400, 'Connect an agent', '<p class="error">This request has expired. Start connecting again from your agent.</p>', user);
      return;
    }
    pending.delete(id);
    const target = new URL(entry.params.redirectUri);
    if (req.body.decision === 'allow') {
      target.searchParams.set('code', await oauth.issueCode(entry.client.client_id, user.id, entry.params));
    } else {
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('error_description', 'The user did not allow access');
    }
    if (entry.params.state !== undefined) {
      target.searchParams.set('state', entry.params.state);
    }
    res.set('Content-Security-Policy', pageContentSecurityPolicy([formTargetFor(entry.params.redirectUri)]));
    res.redirect(302, target.href);
  });

  const gitHubSection = async (user: User): Promise<string> => {
    if (deps.githubApp) {
      const login = await deps.githubApp.connectedLogin(user.id);
      const install = deps.githubApp.installUrl
        ? `<p class="muted">The app can only read repositories it is installed on. <a href="${escapeHtml(deps.githubApp.installUrl)}">Install it</a> on more.</p>`
        : '';
      return login !== null
        ? `<p>Connected as <strong>${escapeHtml(login || 'a GitHub user')}</strong>.</p>
           <form method="post" action="/github/disconnect"><button type="submit">Disconnect</button></form>${install}`
        : `<p>Not connected: only public repositories can be reviewed.</p>
           <p><a href="/github/connect">Connect GitHub</a></p>${install}`;
    }
    const own = (await users.gitHubToken(user.id)) !== null;
    const status = own
      ? `Your own token is set${user.githubLogin ? ` (${user.githubLogin})` : ''}.`
      : deps.gitHubTokenFallback
        ? 'No token of your own; this server’s development token is used.'
        : 'No token set: only public repositories can be reviewed.';
    return `
      <p>${escapeHtml(status)} Every session is checked against GitHub with this token before anything is fetched.</p>
      <form method="post" action="/settings/github-token">
        <label>Personal access token <input type="password" name="token" autocomplete="off" required></label>
        <button type="submit">Save</button>
      </form>
      ${own ? '<form method="post" action="/settings/github-token"><input type="hidden" name="clear" value="1"><button type="submit">Remove my token</button></form>' : ''}`;
  };

  app.get('/settings', async (req, res) => {
    const user = await userFor(req);
    if (!user) {
      notSignedIn(res, req.originalUrl);
      return;
    }
    sendPage(res, 200, 'Settings', `
      <h1>Settings</h1>
      <h2>GitHub access</h2>
      ${await gitHubSection(user)}
      <h2>Connect an agent</h2>
      <p>Add this server to Claude Code as an MCP connector; it signs you in through this page the first time.
        Its <code>review</code> prompt holds the review method.</p>
      <pre>claude mcp add --transport http diffity ${escapeHtml(mcpUrl.href)}</pre>`, user);
  });

  app.post('/settings/github-token', sameOrigin, forms, async (req, res) => {
    const user = await userFor(req);
    if (!user) {
      notSignedIn(res, '/settings');
      return;
    }
    if (deps.githubApp) {
      sendPage(res, 404, 'Settings', '<p class="error">This server connects GitHub through its app; see <a href="/settings">Settings</a>.</p>', user);
      return;
    }
    const token = req.body?.clear === '1' ? null : (typeof req.body?.token === 'string' ? req.body.token.trim() : '') || null;
    await users.setGitHubToken(user.id, token, token ? await service.github.viewerLogin(token) : null);
    res.redirect(303, '/settings');
  });

  app.get('/github/connect', async (req, res) => {
    const user = await userFor(req);
    if (!user) {
      notSignedIn(res, req.originalUrl);
      return;
    }
    if (!deps.githubApp) {
      res.redirect(302, '/settings');
      return;
    }
    res.redirect(302, await deps.githubApp.authorizeUrl(user.id));
  });

  app.get('/github/callback', async (req, res) => {
    const user = await userFor(req);
    if (!user) {
      notSignedIn(res, '/settings');
      return;
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!deps.githubApp || !code || !state) {
      sendPage(res, 400, 'GitHub', '<p class="error">GitHub did not connect. Try again from <a href="/settings">Settings</a>.</p>', user);
      return;
    }
    try {
      await deps.githubApp.complete(user.id, code, state);
    } catch (err) {
      if (!(err instanceof GitHubConnectError)) {
        throw err;
      }
      sendPage(res, 400, 'GitHub', `<p class="error">${escapeHtml(err.message)}</p><p><a href="/settings">Settings</a></p>`, user);
      return;
    }
    res.redirect(302, '/settings');
  });

  app.post('/github/disconnect', sameOrigin, async (req, res) => {
    const user = await userFor(req);
    if (user && deps.githubApp) {
      await deps.githubApp.disconnect(user.id);
    }
    res.redirect(303, '/settings');
  });

  app.get('/', async (req, res) => {
    const user = await userFor(req);
    if (!user) {
      notSignedIn(res, req.originalUrl);
      return;
    }
    const sessions = await reviews.listSessions(user.id);
    const rows = sessions.map(session => `
      <tr>
        <td><a href="/s/${session.id}/">${escapeHtml(`${session.owner}/${session.repo}`)}</a></td>
        <td>${escapeHtml(describeSession(session))}</td>
        <td class="muted">${escapeHtml(session.createdAt.slice(0, 16).replace('T', ' '))}</td>
      </tr>`).join('');
    sendPage(res, 200, 'Sessions', sessions.length > 0
      ? `<h1>Your review sessions</h1><table><tr><th>Repository</th><th>Change</th><th>Created</th></tr>${rows}</table>`
      : `<h1>No review sessions yet</h1><p>Ask your agent to <code>create_session</code> through the diffity MCP connector.
         See <a href="/settings">settings</a> for how to add it.</p>`, user);
  });

  app.use('/s/:sid/api', requireSameOrigin(publicUrl), (_req, res, next) => {
    res.set('Content-Security-Policy', UI_CONTENT_SECURITY_POLICY);
    res.set('Cache-Control', 'no-store');
    next();
  }, uiApiRouter({ service, userFor }));

  app.get('/s/:sid{/*rest}', async (req, res) => {
    const user = await userFor(req);
    if (!user) {
      notSignedIn(res, req.originalUrl);
      return;
    }
    const session = await reviews.getSession(user.id, req.params.sid);
    if (!session || session.id !== req.params.sid) {
      sendPage(res, 404, 'Not found', '<h1>No such session</h1><p><a href="/">Your sessions</a></p>', user);
      return;
    }
    const html = indexHtml();
    if (!html) {
      sendPage(res, 503, 'Not built', '<h1>The review UI is not built</h1><p>Run <code>pnpm build</code> at the repository root.</p>', user);
      return;
    }
    // The UI reads its API and router base from this, so one build serves every session.
    const base = JSON.stringify(`/s/${session.id}`).replaceAll('<', '\\u003c');
    res.status(200)
      .set('Content-Security-Policy', UI_CONTENT_SECURITY_POLICY)
      .set('Cache-Control', 'no-store')
      .type('html')
      .send(html.replace('<head>', `<head><script>window.__DIFFITY_BASE__=${base}</script>`));
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
    if (!res.headersSent) {
      res.status(status).json({
        error: status === 400 ? 'Request body must be valid JSON' : err instanceof Error ? err.message : String(err),
      });
    }
  });

  return app;
}
