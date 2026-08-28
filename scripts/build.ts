#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { copyFileSync, cpSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const steps = [
  'npm run build:skills',
  'npm run build -w @diffity/parser',
  'npm run build -w @diffity/api',
  'npm run build -w @diffity/git',
  'npm run build -w @diffity/github',
  'npm run build -w @diffity/ui',
  'npm run build -w @naturalcycles/diffity',
];

for (const step of steps) {
  execSync(step, { stdio: 'inherit' });
}

copyFileSync(
  resolve(root, 'README.md'),
  resolve(root, 'packages/cli/README.md'),
);

// npm includes a LICENSE only from the package directory, and MIT requires the notice to
// travel with every copy.
copyFileSync(resolve(root, 'LICENSE'), resolve(root, 'packages/cli/LICENSE'));

// Into dist, so the published package carries them and `diffity skills install` has something
// to install from.
const shippedSkills = resolve(root, 'packages/cli/dist/skills');
rmSync(shippedSkills, { recursive: true, force: true });
cpSync(resolve(root, 'skills'), shippedSkills, { recursive: true });
