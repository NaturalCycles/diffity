import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeRepoPath, isRepoName, isSha, Mirrors, parseNameStatus, runGit } from '../src/git.js';
import { git, makeFixture, removeDir, tempDir, type Fixture } from './helpers.js';

let fixture: Fixture;
let dataDir: string;
let mirrors: Mirrors;

beforeAll(() => {
  fixture = makeFixture();
  dataDir = tempDir('mirrors');
  mirrors = new Mirrors(dataDir, fixture.remoteUrl);
});

afterAll(() => {
  removeDir(fixture.root);
  removeDir(dataDir);
});

describe('mirror', () => {
  it('clones blob-less on first use, fetches commits by sha and pins them', async () => {
    await mirrors.fetchCommits('acme', 'widgets', null, [fixture.base, fixture.head1]);
    const gitDir = mirrors.pathFor('acme', 'widgets');
    expect(existsSync(join(gitDir, 'HEAD'))).toBe(true);
    expect(await runGit(['config', 'remote.origin.promisor'], { gitDir })).toContain('true');
    const pinned = await runGit(['for-each-ref', '--format=%(objectname)', 'refs/diffity/keep/'], { gitDir });
    expect(pinned).toContain(fixture.base);
    expect(pinned).toContain(fixture.head1);
    // Nothing but the mirror is left behind in its directory.
    expect(readdirSync(join(dataDir, 'mirrors', 'acme'))).toEqual(['widgets.git']);
  });

  it('never writes a credential into the mirror config', async () => {
    await mirrors.fetchCommits('acme', 'widgets', 'secret-token', [fixture.head2]);
    const config = await runGit(['config', '--list', '--local'], { gitDir: mirrors.pathFor('acme', 'widgets') });
    expect(config).not.toContain('secret-token');
    expect(config).not.toContain('extraheader');
  });

  it('fetches a pull request head, following it when it moves', async () => {
    expect(await mirrors.fetchPullHead('acme', 'widgets', null, 1)).toBe(fixture.head1);
    fixture.pushPull(fixture.head2);
    expect(await mirrors.fetchPullHead('acme', 'widgets', null, 1)).toBe(fixture.head2);
    fixture.pushPull(fixture.head1);
  });

  it('computes the merge base', async () => {
    await mirrors.fetchCommits('acme', 'widgets', null, [fixture.mainTip]);
    expect(await mirrors.mergeBase('acme', 'widgets', null, fixture.mainTip, fixture.head1)).toBe(fixture.base);
  });

  it('refuses a sha that is not in the repository, and a short one', async () => {
    await expect(mirrors.fetchCommits('acme', 'widgets', null, ['0'.repeat(40)])).rejects.toThrow();
    await expect(mirrors.fetchCommits('acme', 'widgets', null, ['abc123'])).rejects.toThrow('Not a full commit sha');
  });

  it('refuses a path that would leave the mirrors directory', () => {
    expect(() => mirrors.pathFor('..', 'x')).toThrow('Not a repository name');
    expect(() => mirrors.pathFor('acme', 'a/b')).toThrow('Not a repository name');
  });

  it('leaves no half-cloned mirror when the remote does not exist', async () => {
    await expect(mirrors.fetchCommits('acme', 'missing', null, [fixture.base])).rejects.toThrow();
    expect(readdirSync(join(dataDir, 'mirrors', 'acme'))).toEqual(['widgets.git']);
  });
});

describe('reading', () => {
  it('diffs two commits in the format the parser expects', async () => {
    const raw = await mirrors.diff('acme', 'widgets', null, fixture.base, fixture.head1);
    expect(raw).toContain('diff --git a/src.ts b/src.ts');
    expect(raw).toContain('+line 10 changed by the feature');
    expect(raw).toContain('b/added.ts');
  });

  it('limits a diff to one path, taken literally', async () => {
    const raw = await mirrors.diff('acme', 'widgets', null, fixture.base, fixture.head1, { path: 'added.ts' });
    expect(raw).toContain('added.ts');
    expect(raw).not.toContain('src.ts');
    expect(await mirrors.diff('acme', 'widgets', null, fixture.base, fixture.head1, { path: '*.ts' })).toBe('');
  });

  it('names the changed files, renames included', async () => {
    const files = await mirrors.nameStatus('acme', 'widgets', null, fixture.base, fixture.head2);
    expect(files).toEqual(expect.arrayContaining([
      { status: 'M', oldPath: 'src.ts', newPath: 'src.ts' },
      { status: 'A', oldPath: 'added.ts', newPath: 'added.ts' },
    ]));
    const renames = await mirrors.renames('acme', 'widgets', null, fixture.head1, fixture.head2);
    expect(renames).toEqual([expect.objectContaining({ oldPath: 'old-name.ts', newPath: 'new-name.ts' })]);
    expect(await mirrors.shortStat('acme', 'widgets', null, fixture.base, fixture.head1)).toMatch(/2 files changed/);
  });

  it('reads a file at a revision, and one missing there as null', async () => {
    expect(await mirrors.readFile('acme', 'widgets', null, fixture.head1, 'added.ts')).toBe('export const added = 1;\n');
    expect(await mirrors.readFile('acme', 'widgets', null, fixture.base, 'added.ts')).toBeNull();
    expect(await mirrors.readFile('acme', 'widgets', null, fixture.base, '../etc/passwd')).toBeNull();
  });

  it('reads many files in one call', async () => {
    const files = await mirrors.readFiles('acme', 'widgets', null, fixture.head1, ['added.ts', 'nope.ts', 'README.md', '/abs']);
    expect(files.get('added.ts')).toBe('export const added = 1;\n');
    expect(files.get('README.md')).toBe('# widgets\n');
    expect(files.get('nope.ts')).toBeNull();
    expect(files.get('/abs')).toBeNull();
    expect((await mirrors.readFiles('acme', 'widgets', null, fixture.head1, [])).size).toBe(0);
  });
});

describe('after the mirror is lost', () => {
  const pinned = () => runGit(['for-each-ref', '--format=%(objectname)', 'refs/diffity/keep/'], { gitDir: mirrors.pathFor('acme', 'widgets') });

  it('clones again and fetches what a read needs', async () => {
    await mirrors.fetchCommits('acme', 'widgets', null, [fixture.base, fixture.head1]);
    const before = await mirrors.diff('acme', 'widgets', null, fixture.base, fixture.head1);
    removeDir(mirrors.pathFor('acme', 'widgets'));
    expect(await mirrors.diff('acme', 'widgets', null, fixture.base, fixture.head1)).toBe(before);
    expect(existsSync(join(mirrors.pathFor('acme', 'widgets'), 'HEAD'))).toBe(true);
    expect(await pinned()).toContain(fixture.base);
    expect(await pinned()).toContain(fixture.head1);
  });

  it('keeps git’s own words when the fetch fails', async () => {
    const otherDir = tempDir('mirrors-broken');
    const broken = tempDir('not-a-repo');
    try {
      const other = new Mirrors(otherDir, fixture.remoteUrl);
      await other.fetchCommits('acme', 'widgets', null, [fixture.base]);
      await runGit(['remote', 'set-url', 'origin', `file://${broken}`], { gitDir: other.pathFor('acme', 'widgets') });
      await expect(other.fetchCommits('acme', 'widgets', null, [fixture.orphan])).rejects.toThrow(
        /could not be fetched into acme\/widgets: .*not .*a git repository/s,
      );
    } finally {
      removeDir(otherDir);
      removeDir(broken);
    }
  });

  it('fetches a commit on no branch by its sha', async () => {
    removeDir(mirrors.pathFor('acme', 'widgets'));
    expect(await mirrors.readFile('acme', 'widgets', null, fixture.orphan, 'src.ts')).toBe('export const orphan = true;\n');
    expect(await pinned()).toContain(fixture.orphan);
  });

  it('says when a sha cannot be had, and refuses a short one', async () => {
    removeDir(mirrors.pathFor('acme', 'widgets'));
    await expect(mirrors.nameStatus('acme', 'widgets', null, '0'.repeat(40), fixture.base)).rejects.toThrow('could not be fetched into acme/widgets');
    await expect(mirrors.readFile('acme', 'widgets', null, 'abc123', 'src.ts')).rejects.toThrow('Not a full commit sha');
  });
});

describe('trees', () => {
  it('fetches only commits as commits, but reads a file from a tree', async () => {
    const tree = git(fixture.work, ['rev-parse', `${fixture.base}^{tree}`]);
    await expect(mirrors.fetchCommits('acme', 'widgets', null, [tree])).rejects.toThrow('Not a commit');
    expect(await mirrors.readFile('acme', 'widgets', null, tree, 'README.md')).toBe('# widgets\n');
  });
});

describe('patch sessions', () => {
  it('applies a patch to the base in a throwaway index and diffs the tree it makes', async () => {
    const patch = git(fixture.work, ['diff', fixture.base, fixture.head1]) + '\n';
    const tree = await mirrors.applyPatch('acme', 'widgets', null, fixture.base, patch);
    expect(tree).toBe(git(fixture.work, ['rev-parse', `${fixture.head1}^{tree}`]));
    const raw = await mirrors.diff('acme', 'widgets', null, fixture.base, tree);
    expect(raw).toContain('+line 10 changed by the feature');
    expect(await mirrors.readFile('acme', 'widgets', null, tree, 'added.ts')).toBe('export const added = 1;\n');
    expect(readdirSync(join(dataDir, 'tmp'))).toEqual([]);
  });

  it('says so when the patch does not apply', async () => {
    const bad = 'diff --git a/src.ts b/src.ts\n--- a/src.ts\n+++ b/src.ts\n@@ -1,1 +1,1 @@\n-not there\n+x\n';
    await expect(mirrors.applyPatch('acme', 'widgets', null, fixture.base, bad)).rejects.toThrow('does not apply');
    expect(readdirSync(join(dataDir, 'tmp'))).toEqual([]);
  });
});

describe('validators', () => {
  it('accepts only full shas, plain names and contained paths', () => {
    expect(isSha('a'.repeat(40))).toBe(true);
    expect(isSha('A'.repeat(40))).toBe(false);
    expect(isRepoName('diffity.js')).toBe(true);
    expect(isRepoName('..')).toBe(false);
    expect(isSafeRepoPath('src/a.ts')).toBe(true);
    for (const bad of ['', '/a', 'a/../b', './a', 'a//b', 'a\\b', 'a\0b']) {
      expect(isSafeRepoPath(bad)).toBe(false);
    }
  });

  it('parses name-status lines, renames included', () => {
    expect(parseNameStatus('M\ta.ts\nR087\told.ts\tnew.ts\n\nbad\n')).toEqual([
      { status: 'M', oldPath: 'a.ts', newPath: 'a.ts' },
      { status: 'R087', oldPath: 'old.ts', newPath: 'new.ts' },
    ]);
  });
});
