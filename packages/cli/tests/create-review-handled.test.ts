import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { AGENT_TRAFFIC_HEADER } from '@diffity/api';
import { InboxStore } from '../src/inbox/store.js';
import { inboxStorePath } from '../src/inbox/paths.js';

let root: string;
let repoDir: string;
let origCwd: string;
let origPath: string | undefined;
let port: number;
let close: () => void;

/**
 * A fake gh ahead on PATH that takes a review and answers with the URL GitHub would give it. The
 * head it reports is the local one, so the server's out-of-sync guard is satisfied.
 */
function writeFakeGh(dir: string): void {
  writeFileSync(join(dir, 'gh'), `#!/bin/sh
case "$1 $2" in
  "--version ") echo "gh version 2.0.0"; exit 0 ;;
  "auth status") exit 0 ;;
  "pr view")
    echo "{\\"number\\":1,\\"title\\":\\"A change\\",\\"url\\":\\"https://github.com/o/r/pull/1\\",\\"headRefOid\\":\\"$FAKE_GH_HEAD\\",\\"createdAt\\":\\"2026-01-01T00:00:00Z\\",\\"author\\":{\\"login\\":\\"alice\\"},\\"body\\":\\"\\"}"
    exit 0 ;;
  "pr diff") exit 0 ;;
  "api user") echo "me"; exit 0 ;;
esac
if [ "$2" = "repos/o/r/pulls/1/reviews" ] && [ "$3" = "--method" ]; then
  cat > /dev/null
  echo '{"html_url":"https://github.com/o/r/pull/1#pullrequestreview-9","id":9}'
  exit 0
fi
if [ "$2" = "repos/o/r/pulls/1/comments" ] && [ "$3" = "--jq" ]; then
  echo 0
  exit 0
fi
echo "[]"
exit 0
`);
  chmodSync(join(dir, 'gh'), 0o755);
}

async function postReview(extra: Record<string, string> = {}): Promise<{ status: number; body: { reviewUrl: string | null } }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/github/create-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...extra },
    body: JSON.stringify({ event: 'APPROVE', body: 'Looks good', comments: [] }),
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-handled-route-'));
  repoDir = join(root, 'repo');
  mkdirSync(repoDir);

  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  const git = (args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 'T']);
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  git(['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  process.env.FAKE_GH_HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();

  const fakeBin = join(root, 'bin');
  mkdirSync(fakeBin);
  writeFakeGh(fakeBin);
  origPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${delimiter}${origPath ?? ''}`;

  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
  process.chdir(repoDir);

  const { startServer } = await import('../src/server.js');
  const started = await startServer({ port: 0, diffArgs: [], effectiveRef: 'work' });
  port = started.port;
  close = started.close;
});

afterAll(() => {
  close?.();
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  delete process.env.FAKE_GH_HEAD;
  if (origPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = origPath;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('a review posted to GitHub', () => {
  it('is not marked when an agent posted it rather than the reader', async () => {
    const { status, body } = await postReview({ [AGENT_TRAFFIC_HEADER]: '1' });

    expect(status).toBe(200);
    expect(body.reviewUrl).toBe('https://github.com/o/r/pull/1#pullrequestreview-9');

    const store = new InboxStore(inboxStorePath());
    const handled = store.latestHandled('o/r#1');
    store.close();
    expect(handled).toBeNull();
  }, 15000);

  it('is marked in the inbox, against the head it was posted for', async () => {
    const { status, body } = await postReview();

    expect(status).toBe(200);
    expect(body.reviewUrl).toBe('https://github.com/o/r/pull/1#pullrequestreview-9');

    const store = new InboxStore(inboxStorePath());
    const handled = store.latestHandled('o/r#1');
    store.close();
    expect(handled).toMatchObject({
      headSha: process.env.FAKE_GH_HEAD,
      event: 'APPROVE',
      reviewUrl: 'https://github.com/o/r/pull/1#pullrequestreview-9',
    });
  }, 15000);

  it('still reaches GitHub when the inbox cannot be written', async () => {
    // Whatever the reason a mark cannot be kept, the review itself is already the reviewer's word.
    rmSync(join(root, 'notes', 'inbox'), { recursive: true, force: true });
    writeFileSync(join(root, 'notes', 'inbox'), 'not a directory\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { status, body } = await postReview();

    expect(status).toBe(200);
    expect(body.reviewUrl).toBe('https://github.com/o/r/pull/1#pullrequestreview-9');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the inbox could not be told'));
    warn.mockRestore();
  }, 15000);
});
