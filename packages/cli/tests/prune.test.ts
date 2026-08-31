import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'diffity-prune-'));
  process.env.DIFFITY_DATA_DIR = root;
});

afterAll(() => {
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

// Prune must delete the same world the registry reads — with an override set, killing one
// world's servers and deleting the other's data would be worse than doing nothing.
describe('prune with a data-dir override', () => {
  it('deletes the override directory and says which one', async () => {
    const { registerPruneCommand } = await import('../src/commands/prune.js');
    writeFileSync(join(root, 'reviews.db'), 'x');
    writeFileSync(join(root, 'registry.json'), '[]');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const program = new Command();
      registerPruneCommand(program);
      program.parse(['prune'], { from: 'user' });

      expect(existsSync(root)).toBe(false);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining(root));
    } finally {
      vi.restoreAllMocks();
    }
  });
});
