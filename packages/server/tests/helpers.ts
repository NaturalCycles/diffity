import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { migrate, openPglite, type Db } from '../src/db.js';
import { startServer, type RunningServer, type ServerOverrides } from '../src/server.js';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@t',
};

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `diffity-server-${prefix}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export async function memoryDb(): Promise<Db> {
  const db = await openPglite();
  await migrate(db);
  return db;
}

export interface Fixture {
  root: string;
  remotes: string;
  work: string;
  /** The commit main was at when feature branched. */
  base: string;
  /** main moved on after feature branched, so it is not the merge base. */
  mainTip: string;
  /** feature's first commit, pushed as refs/pull/1/head. */
  head1: string;
  /** feature's second commit, which moves and renames things. */
  head2: string;
  remoteUrl: (owner: string, repo: string) => string;
  /** Moves refs/pull/1/head to another commit, as a push to the pull request would. */
  pushPull(sha: string): void;
}

/**
 * A bare "GitHub" remote for acme/widgets, reached over file://, with the upload-pack settings
 * GitHub itself has: partial clone filters and fetching by sha.
 */
export function makeFixture(): Fixture {
  const root = tempDir('fixture');
  const remotes = join(root, 'remotes');
  const bare = join(remotes, 'acme', 'widgets.git');
  mkdirSync(join(remotes, 'acme'), { recursive: true });
  git(root, ['init', '--bare', '-b', 'main', bare]);
  git(bare, ['config', 'uploadpack.allowFilter', 'true']);
  git(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);

  const work = join(root, 'work');
  git(root, ['init', '-b', 'main', work]);
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1} of the widget`);
  writeFileSync(join(work, 'src.ts'), lines.join('\n') + '\n');
  writeFileSync(join(work, 'old-name.ts'), 'export const moved = true;\n');
  writeFileSync(join(work, 'README.md'), '# widgets\n');
  writeFileSync(join(work, 'STANDARDS.md'), 'Every P1 must have a test.\n');
  writeFileSync(join(work, '.diffity.json'), JSON.stringify({ review: { standards: 'STANDARDS.md', severities: ['blocker', 'nit'] } }));
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'base']);
  const base = git(work, ['rev-parse', 'HEAD']);

  git(work, ['checkout', '-b', 'feature']);
  lines[9] = 'line 10 changed by the feature';
  writeFileSync(join(work, 'src.ts'), lines.join('\n') + '\n');
  writeFileSync(join(work, 'added.ts'), 'export const added = 1;\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'feature 1']);
  const head1 = git(work, ['rev-parse', 'HEAD']);

  // Three lines inserted above line 10 move it to 13; old-name.ts is renamed.
  const moved = [...lines.slice(0, 5), 'inserted a', 'inserted b', 'inserted c', ...lines.slice(5)];
  writeFileSync(join(work, 'src.ts'), moved.join('\n') + '\n');
  git(work, ['mv', 'old-name.ts', 'new-name.ts']);
  writeFileSync(join(work, 'added.ts'), 'export const added = 2;\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'feature 2']);
  const head2 = git(work, ['rev-parse', 'HEAD']);

  git(work, ['checkout', 'main']);
  writeFileSync(join(work, 'README.md'), '# widgets\n\nmain moved on\n');
  git(work, ['commit', '-am', 'main moves on']);
  const mainTip = git(work, ['rev-parse', 'HEAD']);

  git(work, ['push', bare, 'main', 'feature']);
  git(work, ['push', bare, `${head1}:refs/pull/1/head`]);

  return {
    root,
    remotes,
    work,
    base,
    mainTip,
    head1,
    head2,
    remoteUrl: (owner, repo) => `file://${join(remotes, owner.toLowerCase(), `${repo.toLowerCase()}.git`)}`,
    pushPull: sha => git(work, ['push', '--force', bare, `${sha}:refs/pull/1/head`]),
  };
}

export interface FakeRepo {
  owner: string;
  name: string;
  private: boolean;
  /** Tokens that may read it; a public repository is readable with none. */
  tokens: string[];
  pulls: Record<number, { title: string; baseSha: string; headSha: string; author?: string }>;
}

export interface FakeComment {
  id: number;
  path: string;
  line: number | null;
  start_line: number | null;
  side: string;
  body: string;
  in_reply_to_id: number | null;
  user: { login: string; type: string };
  created_at: string;
  pull: number;
  review_id: number | null;
}

export interface FakeGitHub {
  url: string;
  requests: string[];
  /** Review comments on every pull request, as GitHub holds them. */
  comments: FakeComment[];
  /** The bodies of `POST .../reviews`. */
  postedReviews: { commit_id: string; event: string; body: string; comments: { path: string; line: number; side: string; body: string; start_line?: number }[] }[];
  /** Which root comment ids GitHub shows as resolved. */
  resolved: Set<number>;
  /** Token login for `GET /user`. */
  logins: Record<string, string>;
  /** `POST /login/oauth/access_token`, answered by the test. */
  tokenEndpoint: (params: URLSearchParams) => unknown;
  /** Makes `POST .../reviews` answer this status instead. */
  failReviewWith: number | null;
  close(): Promise<void>;
}

/**
 * The REST, GraphQL and OAuth endpoints diffity uses, answering 404 to anyone not allowed to read
 * a repository.
 */
export async function startFakeGitHub(repos: FakeRepo[]): Promise<FakeGitHub> {
  let nextId = 1000;
  const fake: FakeGitHub = {
    url: '',
    requests: [],
    comments: [],
    postedReviews: [],
    resolved: new Set(),
    logins: {},
    tokenEndpoint: () => ({ error: 'bad_verification_code' }),
    failReviewWith: null,
    close: async () => {},
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://fake');
      fake.requests.push(`${req.method} ${url.pathname}`);
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const page = <T>(items: T[]) => {
        const size = Number(url.searchParams.get('per_page') ?? 30);
        const index = Number(url.searchParams.get('page') ?? 1);
        return items.slice((index - 1) * size, index * size);
      };

      if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
        send(200, fake.tokenEndpoint(new URLSearchParams(raw)));
        return;
      }
      if (url.pathname === '/user') {
        const login = token ? fake.logins[token] : undefined;
        send(login ? 200 : 401, login ? { login } : { message: 'Bad credentials' });
        return;
      }
      if (url.pathname === '/graphql' && req.method === 'POST') {
        const { variables } = JSON.parse(raw) as { variables: { number: number } };
        const roots = fake.comments.filter(c => c.pull === variables.number && !c.in_reply_to_id);
        send(200, {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: roots.map(c => ({
                    isResolved: fake.resolved.has(c.id),
                    line: c.line,
                    originalLine: c.line,
                    diffSide: c.side,
                    path: c.path,
                    comments: { nodes: [{ body: c.body, fullDatabaseId: String(c.id) }] },
                  })),
                },
              },
            },
          },
        });
        return;
      }

      const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/pulls\/(\d+)(\/.*)?)?$/.exec(url.pathname);
      const repo = match
        ? repos.find(r => r.owner.toLowerCase() === match[1].toLowerCase() && r.name.toLowerCase() === match[2].toLowerCase())
        : undefined;
      const allowed = repo && (!repo.private || (token !== null && repo.tokens.includes(token)));
      if (!match || !repo || !allowed) {
        send(404, { message: 'Not Found' });
        return;
      }
      if (!match[3]) {
        send(200, { name: repo.name, private: repo.private, owner: { login: repo.owner } });
        return;
      }
      const number = Number(match[3]);
      const pull = repo.pulls[number];
      if (!pull) {
        send(404, { message: 'Not Found' });
        return;
      }
      const rest = match[4] ?? '';
      if (rest === '/comments') {
        send(200, page(fake.comments.filter(c => c.pull === number)));
        return;
      }
      if (rest === '/reviews' && req.method === 'POST') {
        if (fake.failReviewWith) {
          send(fake.failReviewWith, { message: 'Validation Failed', errors: ['Line could not be resolved'] });
          return;
        }
        const review = JSON.parse(raw) as FakeGitHub['postedReviews'][number];
        fake.postedReviews.push(review);
        const reviewId = nextId++;
        for (const comment of review.comments) {
          fake.comments.push({
            id: nextId++,
            path: comment.path,
            line: comment.line,
            start_line: comment.start_line ?? null,
            side: comment.side,
            body: comment.body,
            in_reply_to_id: null,
            user: { login: fake.logins[token!] ?? 'someone', type: 'User' },
            created_at: '2026-09-02T10:00:00Z',
            pull: number,
            review_id: reviewId,
          });
        }
        send(200, { id: reviewId, html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}#pullrequestreview-${reviewId}` });
        return;
      }
      if (rest === '/reviews') {
        send(200, page([
          { user: { login: 'carol', type: 'User' }, state: 'APPROVED', body: '', submitted_at: '2026-09-02T09:00:00Z' },
          { user: { login: 'dave', type: 'User' }, state: 'COMMENTED', body: '', submitted_at: '2026-09-02T09:00:00Z' },
        ]));
        return;
      }
      const reviewComments = /^\/reviews\/(\d+)\/comments$/.exec(rest);
      if (reviewComments) {
        send(200, page(fake.comments.filter(c => c.review_id === Number(reviewComments[1]))));
        return;
      }
      send(200, {
        number,
        title: pull.title,
        html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}`,
        created_at: '2026-09-01T10:00:00Z',
        body: 'What the change is for',
        state: 'open',
        user: { login: pull.author ?? 'octocat' },
        base: { sha: pull.baseSha, ref: 'main' },
        head: { sha: pull.headSha, ref: 'feature' },
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  fake.url = `http://127.0.0.1:${port}`;
  fake.close = () => new Promise(resolve => server.close(() => resolve()));
  return fake;
}

export function testConfig(dataDir: string, githubApiUrl: string, overrides: Partial<Config> = {}): Config {
  return {
    publicUrl: new URL('http://localhost:5390'),
    port: 0,
    bindHost: '127.0.0.1',
    dataDir,
    secretKey: randomBytes(32),
    secretKeyGenerated: false,
    devLogin: true,
    allowedDomain: 'example.com',
    allowedEmails: [],
    devGitHubToken: null,
    githubApiUrl,
    githubUrl: githubApiUrl,
    githubApp: null,
    databaseUrl: null,
    pgCa: null,
    iapAudience: null,
    trustProxy: false,
    ...overrides,
  };
}

/** A UI build of one line: enough to see the base injected and the page served. */
export function fakeUiDir(root: string): string {
  const dir = join(root, 'ui');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!DOCTYPE html><html><head><title>diffity</title></head><body></body></html>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1);');
  writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return dir;
}

export interface TestServer extends RunningServer {
  base: string;
  dataDir: string;
  config: Config;
}

export async function startTestServer(
  dataDir: string,
  githubApiUrl: string,
  overrides: ServerOverrides = {},
  configOverrides: Partial<Config> = {},
): Promise<TestServer> {
  const port = await freePort();
  const config = testConfig(dataDir, githubApiUrl, { publicUrl: new URL(`http://127.0.0.1:${port}`), ...configOverrides });
  const running = await startServer(config, { rateLimit: false, db: await memoryDb(), ...overrides }, { port, host: '127.0.0.1' });
  return { ...running, base: `http://127.0.0.1:${running.port}`, dataDir, config };
}

/** The public URL has to name the port before the server listens on it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Signs in through the dev login form and answers the session cookie. */
export async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base, 'Sec-Fetch-Site': 'same-origin' },
    body: new URLSearchParams({ email, next: '/' }).toString(),
  });
  const cookie = res.headers.get('set-cookie');
  if (res.status !== 303 || !cookie) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  return cookie.split(';')[0];
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * The whole OAuth dance a connecting agent performs: register, authorize with PKCE while signed
 * in, consent, and trade the code for tokens.
 */
export async function connectAgent(
  base: string,
  cookieOrHeaders: string | Record<string, string>,
  clientName = 'Test Agent',
): Promise<{ clientId: string; accessToken: string; refreshToken: string; verifier: string }> {
  const auth = typeof cookieOrHeaders === 'string' ? { cookie: cookieOrHeaders } : cookieOrHeaders;
  const redirectUri = 'http://127.0.0.1:9/callback';
  const registered = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
  });
  const client = (await registered.json()) as { client_id: string };
  const { verifier, challenge } = pkcePair();
  const authorize = await fetch(
    `${base}/authorize?${new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
    })}`,
    { headers: auth, redirect: 'manual' },
  );
  const html = await authorize.text();
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1];
  if (!request) {
    throw new Error(`no consent form: ${authorize.status} ${html.slice(0, 200)}`);
  }
  const consent = await fetch(`${base}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded', Origin: base, 'Sec-Fetch-Site': 'same-origin' },
    body: new URLSearchParams({ request, decision: 'allow' }).toString(),
  });
  const location = new URL(consent.headers.get('location')!);
  const code = location.searchParams.get('code')!;
  const token = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: redirectUri,
    }).toString(),
  });
  const tokens = (await token.json()) as { access_token: string; refresh_token: string };
  return { clientId: client.client_id, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, verifier };
}
