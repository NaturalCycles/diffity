import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { createReview, getCompareDiff, parsePrCommits, prBaseRef, prCommits } from '../src/pr.js';

let dir: string;
let origPath: string | undefined;

/** The diff of the older commit against the base, as the compare route renders it. */
const COMPARE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 export {};
`;

/**
 * A gh ahead on PATH that answers from files in the temp directory and records every argument it
 * was given, one per line with `--` between calls, so a header with spaces in it is still one line.
 */
function writeFakeGh(): void {
  writeFileSync(join(dir, 'gh'), [
    '#!/bin/sh',
    'for a in "$@"; do printf \'%s\\n\' "$a" >> "$FAKE_GH_DIR/log"; done',
    'printf -- \'--\\n\' >> "$FAKE_GH_DIR/log"',
    'if [ -f "$FAKE_GH_DIR/fail" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi',
    'case "$*" in',
    '  *pulls/1/commits*) cat "$FAKE_GH_DIR/commits.json"; exit 0 ;;',
    '  *compare/*) cat "$FAKE_GH_DIR/compare.diff"; exit 0 ;;',
    '  *baseRefName*) echo \'{"baseRefName":"main"}\'; exit 0 ;;',
    '  *pulls/1/reviews/9/comments*) echo "[]"; exit 0 ;;',
    '  *pulls/1/reviews*--method*) cat > "$FAKE_GH_DIR/posted.json"; echo \'{"html_url":"https://github.com/o/r/pull/1#pullrequestreview-9","id":9}\'; exit 0 ;;',
    '  *pulls/1/comments*) echo "[]"; exit 0 ;;',
    'esac',
    'echo "[]"',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(join(dir, 'gh'), 0o755);
}

/** Every argument gh was called with, across all calls. */
function ghArgs(): string[] {
  const log = join(dir, 'log');
  return existsSync(log) ? readFileSync(log, 'utf-8').split('\n') : [];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'diffity-pr-commits-'));
  writeFakeGh();
  writeFileSync(join(dir, 'commits.json'), JSON.stringify([{ sha: 'older' }, { sha: 'newer' }]));
  writeFileSync(join(dir, 'compare.diff'), COMPARE);
  process.env.FAKE_GH_DIR = dir;
  origPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${origPath ?? ''}`;
});

afterEach(() => {
  if (origPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = origPath;
  }
  delete process.env.FAKE_GH_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('parsePrCommits', () => {
  it('takes the shas and leaves out whatever is not one', () => {
    expect(parsePrCommits(JSON.stringify([{ sha: 'aaa' }, { sha: '' }, { commit: {} }, null, 'x', { sha: 'bbb' }])))
      .toEqual(['aaa', 'bbb']);
  });

  it('answers with none for an empty, unparseable or unexpected body', () => {
    expect(parsePrCommits('')).toEqual([]);
    expect(parsePrCommits('not json')).toEqual([]);
    expect(parsePrCommits('{"message":"Not Found"}')).toEqual([]);
  });
});

describe('prCommits', () => {
  it('asks the forge for every page of them', async () => {
    await expect(prCommits('o', 'r', 1)).resolves.toEqual(['older', 'newer']);

    expect(ghArgs()).toContain('repos/o/r/pulls/1/commits');
    expect(ghArgs()).toContain('--paginate');
  });

  it('answers with none when the forge cannot be asked, so nothing is taken for a PR commit', async () => {
    writeFileSync(join(dir, 'fail'), '');

    await expect(prCommits('o', 'r', 1)).resolves.toEqual([]);
  });
});

describe('prBaseRef', () => {
  it('reads the branch the pull request is against', async () => {
    await expect(prBaseRef('o', 'r', 1)).resolves.toBe('main');
  });

  it('is empty when the forge cannot be read', async () => {
    writeFileSync(join(dir, 'fail'), '');

    await expect(prBaseRef('o', 'r', 1)).resolves.toBe('');
  });
});

describe('getCompareDiff', () => {
  it('asks for one commit against the base branch, as a diff', async () => {
    await expect(getCompareDiff('o', 'r', 'main', 'older')).resolves.toContain('+const b = 2;');

    expect(ghArgs()).toContain('Accept: application/vnd.github.diff');
    expect(ghArgs()).toContain('repos/o/r/compare/main...older');
  });

  it('is empty when the forge cannot be read', async () => {
    writeFileSync(join(dir, 'fail'), '');

    await expect(getCompareDiff('o', 'r', 'main', 'older')).resolves.toBe('');
  });
});

describe('createReview against a named commit', () => {
  const submission = {
    event: 'COMMENT' as const,
    body: 'A pre-review',
    comments: [{ threadId: 't1', filePath: 'src/a.ts', side: 'RIGHT' as const, startLine: null, endLine: 2, body: 'P1: this leaks' }],
  };

  it('posts against that commit, judging the lines by the diff it was handed', async () => {
    const result = await createReview('o', 'r', 1, 'newer', submission, { commitSha: 'older', patch: COMPARE });

    expect(JSON.parse(readFileSync(join(dir, 'posted.json'), 'utf-8'))).toMatchObject({
      commit_id: 'older',
      comments: [{ path: 'src/a.ts', line: 2, side: 'RIGHT' }],
    });
    expect(result).toMatchObject({ submitted: 1, errors: [], commitSha: 'older' });
    // The pull request's own patch says nothing about that commit, so it is never fetched.
    expect(ghArgs()).not.toContain('diff');
  });

  it('posts against the pull request\'s head when nothing else is named', async () => {
    writeFileSync(join(dir, 'compare.diff'), COMPARE);
    const result = await createReview('o', 'r', 1, 'newer', { ...submission, comments: [] }, { patch: COMPARE });

    expect(JSON.parse(readFileSync(join(dir, 'posted.json'), 'utf-8'))).toMatchObject({ commit_id: 'newer' });
    expect(result.commitSha).toBe('newer');
  });
});
