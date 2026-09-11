import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let ghDir: string;
let origCwd: string;
let origPath: string | undefined;
let port: number;
let close: () => void;

const PATCH = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1,2 @@
-const a = 1;
+const a = 2;
+const b = 3;
`;

/**
 * A gh that answers with the comments already on the pull request and keeps the review it is
 * handed, so a test can see what actually went out rather than only what the route reported.
 */
function writeFakeGh(dir: string): void {
  writeFileSync(join(dir, 'gh'), `#!/bin/sh
case "$1 $2" in
  "--version ") echo "gh version 2.0.0"; exit 0 ;;
  "auth status") exit 0 ;;
  "pr view")
    echo "{\\"number\\":1,\\"title\\":\\"A change\\",\\"url\\":\\"https://github.com/o/r/pull/1\\",\\"headRefOid\\":\\"$FAKE_GH_HEAD\\",\\"createdAt\\":\\"2026-01-01T00:00:00Z\\",\\"author\\":{\\"login\\":\\"alice\\"},\\"body\\":\\"\\"}"
    exit 0 ;;
  "pr diff") cat "$FAKE_GH_DIR/patch.diff"; exit 0 ;;
  "api user") echo "me"; exit 0 ;;
esac
if [ "$2" = "repos/o/r/pulls/1/reviews" ] && [ "$3" = "--method" ]; then
  cat > "$FAKE_GH_DIR/posted.json"
  echo '{"html_url":"https://github.com/o/r/pull/1#pullrequestreview-9","id":9}'
  exit 0
fi
if [ "$2" = "repos/o/r/pulls/1/comments" ] && [ "$3" = "--jq" ]; then
  echo 1
  exit 0
fi
if [ "$2" = "repos/o/r/pulls/1/comments" ]; then
  cat "$FAKE_GH_DIR/existing.json"
  exit 0
fi
echo "[]"
exit 0
`);
  chmodSync(join(dir, 'gh'), 0o755);
}

/** What the pull request already carries on a.ts:1, as the REST API reports it. */
function alreadyThere(body: string, login: string): void {
  writeFileSync(
    join(ghDir, 'existing.json'),
    JSON.stringify([{ id: 1, path: 'a.ts', line: 1, side: 'RIGHT', body, user: { login, type: 'User' }, in_reply_to_id: null, start_line: null, created_at: '2026-01-01T00:00:00Z' }]),
  );
}

async function ensureSession(): Promise<string> {
  const session = await (await fetch(`http://127.0.0.1:${port}/api/sessions/ensure`, {
    method: 'POST',
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  })).json() as { id: string };
  return session.id;
}

/** A finding recorded locally, as the page records one, so it has an identity to be known by. */
async function recordFinding(body: string): Promise<string> {
  const sessionId = await ensureSession();
  const res = await fetch(`http://127.0.0.1:${port}/api/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({
      sessionId,
      filePath: 'a.ts',
      side: 'new',
      startLine: 1,
      endLine: 1,
      body,
      author: { name: 'me', type: 'user' },
    }),
  });
  const created = await res.json() as { id?: string };
  if (!created.id) {
    throw new Error(`the thread was not recorded: ${JSON.stringify(created)}`);
  }
  return created.id;
}

interface Posted {
  status: number;
  body: { submitted: number; skipped: number; errors: string[] };
  sent: { body: string }[];
}

async function post(comment: { body: string; threadId: string }): Promise<Posted> {
  rmSync(join(ghDir, 'posted.json'), { force: true });
  const res = await fetch(`http://127.0.0.1:${port}/api/github/create-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({
      event: 'COMMENT',
      body: 'One finding.',
      comments: [{ ...comment, filePath: 'a.ts', side: 'RIGHT', startLine: null, endLine: 1 }],
    }),
  });
  const reported = await res.json();
  let sent: { body: string }[] = [];
  try {
    sent = (JSON.parse(readFileSync(join(ghDir, 'posted.json'), 'utf-8')) as { comments: { body: string }[] }).comments;
  } catch {
    // no review reached the forge
  }
  return { status: res.status, body: reported, sent };
}

beforeAll(async () => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-dedup-route-'));
  repoDir = join(root, 'repo');
  ghDir = join(root, 'gh-state');
  mkdirSync(repoDir);
  mkdirSync(ghDir);
  writeFileSync(join(ghDir, 'patch.diff'), PATCH);

  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  const git = (args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 'T']);
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 2;\nconst b = 3;\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  git(['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  process.env.FAKE_GH_HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
  process.env.FAKE_GH_DIR = ghDir;

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
  delete process.env.FAKE_GH_DIR;
  if (origPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = origPath;
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    // still being written to
  }
});

describe('a finding on a line that already carries a comment', () => {
  it('reaches GitHub when it is not the comment already there', async () => {
    alreadyThere('P2: an older remark, resolved since', 'me');

    const posted = await post({ body: 'P1: a different problem entirely', threadId: 'fresh-finding' });

    expect(posted.status).toBe(200);
    expect(posted.body.skipped).toBe(0);
    expect(posted.body.submitted).toBe(1);
    expect(posted.sent.map(one => one.body)).toEqual(['P1: a different problem entirely']);
  }, 15000);

  it('is held back when it is word for word the one already there', async () => {
    alreadyThere('P2: the very same finding', 'me');

    const posted = await post({ body: 'P2: the very same finding', threadId: 'same-again' });

    expect(posted.status).toBe(200);
    expect(posted.body.skipped).toBe(1);
    expect(posted.body.submitted).toBe(0);
    expect(posted.sent).toEqual([]);
  }, 15000);

  it('goes out when the identical wording is another reviewer\'s, not ours', async () => {
    alreadyThere('P2: the very same finding', 'someone-else');

    const posted = await post({ body: 'P2: the very same finding', threadId: 'mine-too' });

    expect(posted.status).toBe(200);
    expect(posted.body.submitted).toBe(1);
    expect(posted.sent.map(one => one.body)).toEqual(['P2: the very same finding']);
  }, 15000);

  it('is held back once the record says it went out, however it reads now', async () => {
    // The forge cannot edit the comment already there, so a reworded resend would land beside it.
    writeFileSync(join(ghDir, 'existing.json'), '[]');
    const threadId = await recordFinding('P2: as first written');

    const first = await post({ body: 'P2: as first written', threadId });
    expect(first.body.submitted).toBe(1);

    alreadyThere('P2: as first written', 'me');
    const again = await post({ body: 'P2: reworded since, same finding', threadId });

    expect(again.body.skipped).toBe(1);
    expect(again.body.submitted).toBe(0);
  }, 15000);

  it('is held back when it was pulled from GitHub rather than sent from here', async () => {
    // A pulled comment knows the forge comment it exists as but was never submitted from here,
    // and editing it locally moves it out of reach of the wording comparison.
    alreadyThere('P2: someone else wrote this on the pull request', 'someone-else');
    const sessionId = await ensureSession();
    await fetch(`http://127.0.0.1:${port}/api/github/pull-comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ sessionId }),
    });
    const threads = await (await fetch(`http://127.0.0.1:${port}/api/threads?session=${sessionId}`)).json() as {
      id: string;
      githubCommentId: number | null;
      comments: { body: string }[];
    }[];
    const pulled = threads.find(thread => thread.comments[0]?.body.includes('someone else wrote this'));
    expect(pulled?.githubCommentId).toBe(1);

    const again = await post({ body: 'P2: reworded by me after pulling it', threadId: pulled!.id });

    expect(again.body.skipped).toBe(1);
    expect(again.body.submitted).toBe(0);
  }, 15000);
});
