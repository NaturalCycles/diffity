import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let ghDir: string;
let origCwd: string;
let origPath: string | undefined;
let port: number;
let close: () => void;
/** The commit this checkout is on: an earlier commit of the pull request. */
let localHead: string;

/** The head the pull request has moved on to, which this checkout does not have. */
const PR_HEAD = 'b'.repeat(40);

/** The diff of the reviewed commit against the base branch, as the compare route renders it. */
const COMPARE = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,2 @@
 const a = 1;
+const b = 2;
`;

/**
 * A gh ahead on PATH answering from files under its own directory, so nothing reaches the forge.
 * Every argument is logged on a line of its own, with `--` between calls, so a header carrying
 * spaces is still one line to read back.
 */
function writeFakeGh(): void {
  writeFileSync(join(ghDir, 'gh'), [
    '#!/bin/sh',
    'for a in "$@"; do printf \'%s\\n\' "$a" >> "$FAKE_GH_DIR/log"; done',
    'printf -- \'--\\n\' >> "$FAKE_GH_DIR/log"',
    'case "$1 $2" in',
    '  "--version ") echo "gh version 2.0.0"; exit 0 ;;',
    '  "auth status") exit 0 ;;',
    'esac',
    'case "$*" in',
    '  *baseRefName*) echo \'{"baseRefName":"main"}\'; exit 0 ;;',
    '  *"pr view"*|*"pr "*"view"*)',
    '    echo "{\\"number\\":1,\\"title\\":\\"A change\\",\\"url\\":\\"https://github.com/o/r/pull/1\\",\\"headRefOid\\":\\"$FAKE_GH_PR_HEAD\\",\\"createdAt\\":\\"2026-01-01T00:00:00Z\\",\\"author\\":{\\"login\\":\\"alice\\"},\\"body\\":\\"\\"}"',
    '    exit 0 ;;',
    '  *pulls/1/commits*) cat "$FAKE_GH_DIR/commits.json"; exit 0 ;;',
    '  *compare/*) cat "$FAKE_GH_DIR/compare.diff"; exit 0 ;;',
    '  *graphql*) echo \'{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\'; exit 0 ;;',
    '  *"api user"*) echo "me"; exit 0 ;;',
    '  *pulls/1/reviews/9/comments*) echo "[]"; exit 0 ;;',
    '  *pulls/1/reviews*--method*) cat > "$FAKE_GH_DIR/posted.json"; echo \'{"html_url":"https://github.com/o/r/pull/1#pullrequestreview-9","id":9}\'; exit 0 ;;',
    '  *pulls/1/reviews*) echo "[]"; exit 0 ;;',
    '  *pulls/1/comments*--jq*) echo 2; exit 0 ;;',
    '  *pulls/1/comments*) cat "$FAKE_GH_DIR/comments.json"; exit 0 ;;',
    'esac',
    'echo "[]"',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(join(ghDir, 'gh'), 0o755);
}

/** One inline comment on the pull request, as the forge's REST route reports one. */
function remoteComment(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 900, path: 'a.ts', line: 1, start_line: null, side: 'RIGHT', body: 'A remark',
    in_reply_to_id: null, user: { login: 'alice', type: 'User' }, created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function ghArgs(): string[] {
  const log = join(ghDir, 'log');
  return existsSync(log) ? readFileSync(log, 'utf-8').split('\n') : [];
}

async function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const review = {
  event: 'COMMENT',
  body: 'A pre-review',
  comments: [{ threadId: 't1', filePath: 'a.ts', side: 'RIGHT', startLine: null, endLine: 2, body: 'P1: this leaks' }],
};

beforeAll(async () => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-moved-on-'));
  repoDir = join(root, 'repo');
  ghDir = join(root, 'bin');
  mkdirSync(repoDir);
  mkdirSync(ghDir);

  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  const git = (args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 'T']);
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\nconst b = 2;\n');
  git(['add', '.']);
  git(['commit', '-m', 'the reviewed commit']);
  git(['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  localHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();

  writeFakeGh();
  writeFileSync(join(ghDir, 'compare.diff'), COMPARE);
  process.env.FAKE_GH_DIR = ghDir;
  process.env.FAKE_GH_PR_HEAD = PR_HEAD;
  origPath = process.env.PATH;
  process.env.PATH = `${ghDir}${delimiter}${origPath ?? ''}`;

  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
  process.chdir(repoDir);

  const { startServer } = await import('../src/server.js');
  const started = await startServer({ port: 0, diffArgs: [], effectiveRef: 'work' });
  port = started.port;
  close = started.close;
});

beforeEach(() => {
  rmSync(join(ghDir, 'log'), { force: true });
  rmSync(join(ghDir, 'posted.json'), { force: true });
  // The local head is one of the pull request's commits, and not its newest.
  writeFileSync(join(ghDir, 'commits.json'), JSON.stringify([{ sha: localHead }, { sha: PR_HEAD }]));
  writeFileSync(join(ghDir, 'comments.json'), '[]');
});

afterAll(() => {
  close?.();
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  delete process.env.FAKE_GH_DIR;
  delete process.env.FAKE_GH_PR_HEAD;
  if (origPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = origPath;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('posting a review from a checkout the pull request has moved past', () => {
  it('posts against the commit that was reviewed, judging the lines by that commit\'s diff', async () => {
    const { status, text } = await post('/api/github/create-review', review);

    expect(status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ submitted: 1, errors: [], commitSha: localHead });
    expect(JSON.parse(readFileSync(join(ghDir, 'posted.json'), 'utf-8'))).toMatchObject({
      commit_id: localHead,
      comments: [{ path: 'a.ts', line: 2, side: 'RIGHT' }],
    });
    // The lines came from the compare of that commit against the base branch, not the PR's patch.
    expect(ghArgs()).toContain('Accept: application/vnd.github.diff');
    expect(ghArgs()).toContain(`repos/o/r/compare/main...${localHead}`);
  }, 20000);

  it('marks the pull request handled against the commit reviewed, not the head it has now', async () => {
    const { InboxStore } = await import('../src/inbox/store.js');
    const { inboxStorePath } = await import('../src/inbox/paths.js');

    expect((await post('/api/github/create-review', review)).status).toBe(200);

    const store = new InboxStore(inboxStorePath());
    const handled = store.latestHandled('o/r#1');
    store.close();
    expect(handled).toMatchObject({ headSha: localHead, event: 'COMMENT' });
  }, 20000);

  it('is still out of sync when the local head is no commit of the pull request', async () => {
    writeFileSync(join(ghDir, 'commits.json'), JSON.stringify([{ sha: PR_HEAD }]));

    const { status, text } = await post('/api/github/create-review', review);

    expect(status).toBe(409);
    expect(text).toContain('out of sync');
    expect(existsSync(join(ghDir, 'posted.json'))).toBe(false);
  }, 20000);
});

describe('pulling comments into a checkout the pull request has moved past', () => {
  async function sessionId(): Promise<string> {
    const info = await (await fetch(`http://127.0.0.1:${port}/api/info`)).json() as { sessionId: string };
    return info.sessionId;
  }

  it('creates the threads it can place and counts the ones it cannot', async () => {
    writeFileSync(join(ghDir, 'comments.json'), JSON.stringify([
      remoteComment({ id: 901, line: 1, body: 'This line is here' }),
      remoteComment({ id: 902, line: 900, body: 'This line is past the end of the file' }),
      remoteComment({ id: 903, path: 'gone.ts', line: 3, body: 'This file is not in the checkout' }),
    ]));

    const { status, text } = await post('/api/github/pull-comments', { sessionId: await sessionId() });

    expect(status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ pulled: 1, unmapped: 2 });

    const threads = await (await fetch(`http://127.0.0.1:${port}/api/threads`)).json() as { comments: { body: string }[] }[];
    const bodies = threads.flatMap(thread => thread.comments.map(comment => comment.body));
    expect(bodies).toContain('This line is here');
    expect(bodies).not.toContain('This line is past the end of the file');
    expect(bodies).not.toContain('This file is not in the checkout');
  }, 20000);

  it('is still out of sync when the local head is no commit of the pull request', async () => {
    writeFileSync(join(ghDir, 'commits.json'), JSON.stringify([{ sha: PR_HEAD }]));

    const { status, text } = await post('/api/github/pull-comments', { sessionId: await sessionId() });

    expect(status).toBe(409);
    expect(text).toContain('out of sync');
  }, 20000);
});
