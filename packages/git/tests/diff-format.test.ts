import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let repoDir: string;
let origCwd: string;

function git(cmd: string) {
  execSync(`git ${cmd}`, { cwd: repoDir, stdio: 'pipe' });
}

function writeFile(name: string, content: string) {
  writeFileSync(join(repoDir, name), content);
}

beforeAll(() => {
  origCwd = process.cwd();
  repoDir = mkdtempSync(join(tmpdir(), 'diffity-format-test-'));

  git('init -b main');
  git('config user.email "test@test.com"');
  git('config user.name "Test"');

  // git config that alters the default diff format and previously broke parsing
  git('config diff.mnemonicprefix true');
  git('config color.ui always');

  writeFile('base.txt', 'a\nb\n');
  git('add .');
  git('commit -m "initial commit"');

  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(origCwd);
  rmSync(repoDir, { recursive: true, force: true });
});

describe('diff format neutralization', () => {
  it('emits standard a/ b/ prefixes despite diff.mnemonicprefix', async () => {
    const { resolveRef } = await import('../src/diff.js');
    writeFile('base.txt', 'a\nc\n');

    const raw = resolveRef('unstaged');

    expect(raw).toContain('diff --git a/base.txt b/base.txt');
    expect(raw).toContain('--- a/base.txt');
    expect(raw).toContain('+++ b/base.txt');
    // no ANSI color escapes even with color.ui=always
    expect(raw).not.toMatch(/\x1b\[/);

    git('checkout -- base.txt');
  });

  it('lists file names without color escapes despite color.ui', async () => {
    const { getDiffFiles } = await import('../src/diff.js');
    writeFile('base.txt', 'a\nd\n');

    const files = getDiffFiles('unstaged');

    expect(files).toEqual(['base.txt']);
    expect(files.join('')).not.toMatch(/\x1b\[/);

    git('checkout -- base.txt');
  });

  it('emits a diffstat without color escapes despite color.ui', async () => {
    const { getDiffStatForRef } = await import('../src/diff.js');
    writeFile('base.txt', 'a\ne\n');

    const stat = getDiffStatForRef('unstaged');

    expect(stat).toContain('base.txt');
    expect(stat).not.toMatch(/\x1b\[/);

    git('checkout -- base.txt');
  });

  it('emits standard prefixes for untracked files', async () => {
    const { resolveRef } = await import('../src/diff.js');
    writeFile('untracked.txt', 'x\ny\n');

    const raw = resolveRef('work');

    expect(raw).toContain('diff --git a/untracked.txt b/untracked.txt');
    expect(raw).toContain('+++ b/untracked.txt');
    expect(raw).not.toMatch(/\x1b\[/);

    execSync(`rm "${join(repoDir, 'untracked.txt')}"`, { stdio: 'pipe' });
  });
});
