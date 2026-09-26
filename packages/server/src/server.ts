import { createServer, type Server } from 'node:http';
import type { JWTVerifyGetKey } from 'jose';
import type { Config } from './config.js';
import { openDb, type Db } from './db.js';
import { Users, WebSessions } from './users.js';
import { OAuthProvider } from './oauth.js';
import { Reviews } from './reviews.js';
import { Mirrors, githubRemoteUrl, type RemoteUrlBuilder } from './git.js';
import { GitHubApi, StoredTokenAccess, type GitHubAccess } from './github.js';
import { GitHubAppAccess } from './github-app.js';
import { ReviewService } from './service.js';
import { DevLoginProvider, IapLogin } from './login.js';
import { createApp } from './app.js';

export interface ServerOverrides {
  db?: Db;
  remoteUrl?: RemoteUrlBuilder;
  gitHubAccess?: GitHubAccess;
  /** IAP's signing keys, instead of fetching Google's. */
  iapKeys?: JWTVerifyGetKey;
  uiDir?: string | null;
  rateLimit?: boolean;
  version?: string;
}

export interface RunningServer {
  server: Server;
  port: number;
  db: Db;
  oauth: OAuthProvider;
  users: Users;
  service: ReviewService;
  githubApp: GitHubAppAccess | null;
  close(): Promise<void>;
}

export async function startServer(
  config: Config,
  overrides: ServerOverrides = {},
  listen: { port?: number; host?: string } = {},
): Promise<RunningServer> {
  const db = overrides.db ?? await openDb(config);
  const users = new Users(db, config.secretKey);
  const webSessions = new WebSessions(db);
  const oauth = new OAuthProvider(db, { resourceUrl: new URL('/mcp', config.publicUrl) });
  const reviews = new Reviews(db);
  const mirrors = new Mirrors(config.dataDir, overrides.remoteUrl ?? githubRemoteUrl);
  const api = new GitHubApi(config.githubApiUrl);
  const githubApp = config.githubApp
    ? new GitHubAppAccess(db, config.secretKey, config.githubApp, {
        githubUrl: config.githubUrl,
        api,
        callbackUrl: new URL('/github/callback', config.publicUrl).href,
        fallbackToken: config.devGitHubToken,
      })
    : null;
  const access = overrides.gitHubAccess ?? githubApp ?? new StoredTokenAccess(users, config.devGitHubToken);
  const service = new ReviewService(reviews, mirrors, api, access, config.publicUrl);

  const app = createApp({
    config,
    users,
    webSessions,
    oauth,
    service,
    devLogin: config.devLogin ? new DevLoginProvider(config) : null,
    iap: config.iapAudience ? new IapLogin({ ...config, iapAudience: config.iapAudience }, overrides.iapKeys) : null,
    githubApp,
    uiDir: overrides.uiDir ?? null,
    version: overrides.version ?? '0.0.0',
    rateLimit: overrides.rateLimit,
    gitHubTokenFallback: config.devGitHubToken !== null,
  });

  const server = createServer(app);
  const purge = setInterval(() => {
    const now = Date.now();
    void Promise.all([
      oauth.purgeExpired(),
      db.query('DELETE FROM web_sessions WHERE expires_at < $1', [now]),
      db.query('DELETE FROM github_oauth_states WHERE expires_at < $1', [now]),
    ]).catch(err => console.error('Purging expired rows failed:', err));
  }, 60 * 60 * 1000);
  purge.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port ?? config.port, listen.host ?? config.bindHost, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;

  return {
    server,
    port,
    db,
    oauth,
    users,
    service,
    githubApp,
    close: () =>
      new Promise(resolve => {
        clearInterval(purge);
        server.closeAllConnections();
        server.close(() => {
          void db.close().then(resolve, resolve);
        });
      }),
  };
}
