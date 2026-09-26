import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config.js';
import { startServer } from './server.js';

declare const __DIFFITY_VERSION__: string | undefined;

const here = dirname(fileURLToPath(import.meta.url));
const version = typeof __DIFFITY_VERSION__ === 'string' ? __DIFFITY_VERSION__ : 'dev';

/** The UI builds into the server's dist, which is next to this module or, from source, beside src. */
function findUiDir(): string | null {
  const candidates = [join(here, 'ui/client'), join(here, '../dist/ui/client')];
  return candidates.find(dir => existsSync(join(dir, 'index.html'))) ?? null;
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`diffity-server: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (config.secretKeyGenerated) {
    console.warn('Warning: DIFFITY_SECRET_KEY is not set; using a key for this run only. Saved GitHub tokens will not survive a restart.');
  }
  if (!config.devLogin && !config.iapAudience) {
    console.warn('Warning: no sign-in method is enabled (DIFFITY_IAP_AUDIENCE behind IAP, or DIFFITY_DEV_LOGIN=1 on localhost).');
  }
  const uiDir = findUiDir();
  if (!uiDir) {
    console.warn('Warning: the review UI is not built; run `npm run build` at the repository root.');
  }

  const running = await startServer(config, { uiDir, version });
  console.log(`diffity-server ${version} listening on port ${running.port}, public URL ${config.publicUrl.href}`);
  console.log(`MCP endpoint: ${new URL('/mcp', config.publicUrl).href}`);

  const stop = () => {
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
