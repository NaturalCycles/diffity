import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { Config } from './config.js';
import { Store } from './db.js';
import { Users, WebSessions } from './users.js';
import { OAuthProvider } from './oauth.js';
import { Reviews } from './reviews.js';
import { Mirrors, githubRemoteUrl, type RemoteUrlBuilder } from './git.js';
import { GitHubApi, StoredTokenAccess, type GitHubAccess } from './github.js';
import { ReviewService } from './service.js';
import { DevLoginProvider, type LoginProvider } from './login.js';
import { createApp } from './app.js';

export interface ServerOverrides {
  remoteUrl?: RemoteUrlBuilder;
  gitHubAccess?: GitHubAccess;
  login?: LoginProvider | null;
  uiDir?: string | null;
  rateLimit?: boolean;
  version?: string;
}

export interface RunningServer {
  server: Server;
  port: number;
  store: Store;
  oauth: OAuthProvider;
  users: Users;
  service: ReviewService;
  close(): Promise<void>;
}

export async function startServer(
  config: Config,
  overrides: ServerOverrides = {},
  listen: { port?: number; host?: string } = {},
): Promise<RunningServer> {
  const store = new Store(join(config.dataDir, 'diffity.db'));
  const users = new Users(store, config.secretKey);
  const webSessions = new WebSessions(store);
  const oauth = new OAuthProvider(store, { resourceUrl: new URL('/mcp', config.publicUrl) });
  const reviews = new Reviews(store);
  const mirrors = new Mirrors(config.dataDir, overrides.remoteUrl ?? githubRemoteUrl);
  const access = overrides.gitHubAccess ?? new StoredTokenAccess(users, config.devGitHubToken);
  const service = new ReviewService(reviews, mirrors, new GitHubApi(config.githubApiUrl), access, config.publicUrl);
  const login = overrides.login !== undefined ? overrides.login : config.devLogin ? new DevLoginProvider(config) : null;

  const app = createApp({
    config,
    users,
    webSessions,
    oauth,
    service,
    login,
    uiDir: overrides.uiDir ?? null,
    version: overrides.version ?? '0.0.0',
    rateLimit: overrides.rateLimit,
    gitHubTokenFallback: config.devGitHubToken !== null,
  });

  const server = createServer(app);
  const purge = setInterval(() => oauth.purgeExpired(), 60 * 60 * 1000);
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
    store,
    oauth,
    users,
    service,
    close: () =>
      new Promise(resolve => {
        clearInterval(purge);
        server.closeAllConnections();
        server.close(() => {
          store.close();
          resolve();
        });
      }),
  };
}
