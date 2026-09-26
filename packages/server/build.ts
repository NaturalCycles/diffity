import { build } from 'esbuild';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, 'dist');
const uiSource = join(distDir, 'ui/client');
const { version } = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')) as { version: string };

// Not the whole of dist: the UI's build writes into dist/ui.
rmSync(join(distDir, 'index.js'), { force: true });

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
    '@diffity/parser': join(here, '../parser/src/index.ts'),
  },
  define: { __DIFFITY_VERSION__: JSON.stringify(version) },
  minifySyntax: true,
  treeShaking: true,
});

copyFileSync(join(here, 'src/review-prompt.md'), join(distDir, 'review-prompt.md'));

if (!existsSync(join(uiSource, 'index.html'))) {
  throw new Error(`${uiSource} is missing: build @diffity/ui first (npm run build at the repository root)`);
}
