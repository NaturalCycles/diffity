import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config.js';
import { startServer } from './server.js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const pkg = require('../package.json') as { version: string };

/** The build copies the UI next to the server; running from source uses the CLI's build of it. */
function findUiDir(): string | null {
  const candidates = [join(here, 'ui'), join(here, '../../cli/dist/ui/client')];
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
  if (!config.devLogin) {
    console.warn('Warning: no sign-in method is enabled (set DIFFITY_DEV_LOGIN=1 on localhost).');
  }
  const uiDir = findUiDir();
  if (!uiDir) {
    console.warn('Warning: the review UI is not built; run `npm run build` at the repository root.');
  }

  const running = await startServer(config, { uiDir, version: pkg.version });
  console.log(`diffity-server ${pkg.version} listening on port ${running.port}, public URL ${config.publicUrl.href}`);
  console.log(`MCP endpoint: ${new URL('/mcp', config.publicUrl).href}`);

  const stop = () => {
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
