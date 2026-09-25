import { build } from 'esbuild';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, 'dist');
const uiSource = join(here, '../cli/dist/ui/client');

rmSync(distDir, { recursive: true, force: true });

await build({
  entryPoints: [join(here, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: join(distDir, 'index.js'),
  banner: { js: '#!/usr/bin/env node' },
  // Installed as the package's own dependencies; the workspace packages are bundled in.
  packages: 'external',
  alias: {
    '@diffity/api': join(here, '../api/src/index.ts'),
    '@diffity/git': join(here, '../git/src/index.ts'),
    '@diffity/parser': join(here, '../parser/src/index.ts'),
  },
  minifySyntax: true,
  treeShaking: true,
});

// Copied rather than referenced, so dist is the whole server and a container needs nothing else.
if (!existsSync(join(uiSource, 'index.html'))) {
  throw new Error(`${uiSource} is missing: build @diffity/ui first (npm run build at the repository root)`);
}
cpSync(uiSource, join(distDir, 'ui'), { recursive: true });
