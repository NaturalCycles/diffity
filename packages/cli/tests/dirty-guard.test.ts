import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let origCwd: string;
let origPath: string | undefined;
let port: number;
let close: () => void;
let markerPath: string;
let sessionId: string;

// A fake gh serving one pull request whose head is the repo's real HEAD, so the head-sync guard
// passes and only dirtiness decides. Posting a review touches FAKE_GH_MARKER, so a test can tell
// "refused before the forge" from "the forge refused".
function writeFakeGh(dir: string, headSha: string): void {
  writeFileSync(join(dir, 'gh'), `#!/bin/sh
case "$1 $2" in
  "--version ") echo "gh version 2.0.0"; exit 0 ;;
  "auth status") exit 0 ;;
  "pr view")
    echo '{"number":1,"title":"One PR","url":"https://github.com/o/r/pull/1","headRefOid":"${headSha}","createdAt":"2026-01-01T00:00:00Z","author":{"login":"me"},"body":""}'
    exit 0 ;;
  "pr diff") cat <<'PATCH'
diff --git a/a.ts b/a.ts
index 0000000..1111111 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,4 @@
 line one
+line two added
 line three
 line four
PATCH
    exit 0 ;;
  "api user") echo "me"; exit 0 ;;
  "api repos/o/r/pulls/1/comments")
    if [ "$3" = "--jq" ]; then echo 0; exit 0; fi
    if [ -n "$FAKE_GH_EXTRA_COMMENT" ]; then
      echo '[{"id":55,"in_reply_to_id":null,"path":"a.ts","side":"RIGHT","line":2,"start_line":null,"body":"remote finding","user":{"login":"alice","type":"User"},"created_at":"2026-01-01T00:00:00Z"},{"id":56,"in_reply_to_id":null,"path":"a.ts","side":"RIGHT","line":3,"start_line":null,"body":"second finding","user":{"login":"alice","type":"User"},"created_at":"2026-01-02T00:00:00Z"}]'
    else
      echo '[{"id":55,"in_reply_to_id":null,"path":"a.ts","side":"RIGHT","line":2,"start_line":null,"body":"remote finding","user":{"login":"alice","type":"User"},"created_at":"2026-01-01T00:00:00Z"}]'
    fi
    exit 0 ;;
  "api repos/o/r/pulls/1/reviews")
    if [ "$3" = "--method" ]; then
      cat > /dev/null
      touch "$FAKE_GH_MARKER"
      echo '{"id":7,"html_url":"https://github.com/o/r/pull/1#pullrequestreview-7"}'
    else
      echo "[]"
    fi
    exit 0 ;;
  "api repos/o/r/pulls/1/reviews/7/comments") echo "[]"; exit 0 ;;
  "api graphql") echo '{}'; exit 0 ;;
  *) echo "[]"; exit 0 ;;
esac
`);
  chmodSync(join(dir, 'gh'), 0o755);
}

async function post(path: string, body: unknown): Promise<{ status: number; body: { error?: string; submitted?: number; pulled?: number; skipped?: number } }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'x-diffity-agent': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// Line 4 on purpose: the fake forge already holds comments on lines 2 and 3, and an existing
// comment at the same position would make the submission "skipped" rather than "submitted".
function submissionOn(filePath: string) {
  return {
    event: 'COMMENT',
    body: 'Summary',
    comments: [{ filePath, side: 'RIGHT', startLine: null, endLine: 4, body: 'P2: check this' }],
  };
}

beforeAll(async () => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-dirty-'));
  repoDir = join(root, 'repo');
  mkdirSync(repoDir);

  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  const git = (args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'pipe', encoding: 'utf-8' });
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 'T']);
  writeFileSync(join(repoDir, 'a.ts'), 'line one\nline two added\nline three\nline four\n');
  writeFileSync(join(repoDir, 'b.ts'), 'const b = 1;\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  git(['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  const headSha = git(['rev-parse', 'HEAD']).trim();

  const fakeBin = join(root, 'bin');
  mkdirSync(fakeBin);
  writeFakeGh(fakeBin, headSha);
  origPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${delimiter}${origPath ?? ''}`;
  markerPath = join(root, 'review-posted');
  process.env.FAKE_GH_MARKER = markerPath;

  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
  process.chdir(repoDir);

  const { startServer } = await import('../src/server.js');
  const started = await startServer({ port: 0, diffArgs: [], effectiveRef: 'work' });
  port = started.port;
  close = started.close;

  const info = await fetch(`http://127.0.0.1:${port}/api/info`, { headers: { 'x-diffity-agent': '1' } });
  sessionId = (await info.json()).sessionId;
}, 20000);

afterAll(() => {
  close?.();
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  delete process.env.FAKE_GH_MARKER;
  delete process.env.FAKE_GH_EXTRA_COMMENT;
  if (origPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = origPath;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('dirt only blocks the files it can mis-anchor', () => {
  it('posts a review while an unrelated scratch file is dirty', async () => {
    writeFileSync(join(repoDir, 'scratch.mjs'), 'console.log("validated a claim");\n');

    const { status, body } = await post('/api/github/create-review', submissionOn('a.ts'));

    expect(status).toBe(200);
    expect(body.submitted).toBe(1);
    expect(existsSync(markerPath)).toBe(true);
    rmSync(markerPath);
  }, 15000);

  it('refuses when a commented file itself is dirty, before reaching the forge', async () => {
    writeFileSync(join(repoDir, 'a.ts'), 'line one CHANGED\nline two added\nline three\nline four\n');

    const { status, body } = await post('/api/github/create-review', submissionOn('a.ts'));

    expect(status).toBe(409);
    expect(body.error).toContain('a.ts');
    expect(existsSync(markerPath)).toBe(false);

    execFileSync('git', ['checkout', '--', 'a.ts'], { cwd: repoDir, stdio: 'pipe' });
  }, 15000);

  it('pulls comments while an unrelated scratch file is dirty', async () => {
    writeFileSync(join(repoDir, 'scratch.mjs'), 'console.log("validated a claim");\n');

    const { status, body } = await post('/api/github/pull-comments', { sessionId });

    expect(status).toBe(200);
    expect(body.pulled).toBe(1);
  }, 15000);

  it('re-pulls already-known threads even when their file is dirty', async () => {
    writeFileSync(join(repoDir, 'a.ts'), 'line one CHANGED\nline two added\nline three\nline four\n');

    const { status, body } = await post('/api/github/pull-comments', { sessionId });

    expect(status).toBe(200);
    expect(body.pulled).toBe(0);
    expect(body.skipped).toBe(1);
  }, 15000);

  it('refuses to pull a new thread onto a dirty file', async () => {
    writeFileSync(join(repoDir, 'a.ts'), 'line one CHANGED\nline two added\nline three\nline four\n');
    process.env.FAKE_GH_EXTRA_COMMENT = '1';

    const { status, body } = await post('/api/github/pull-comments', { sessionId });

    expect(status).toBe(409);
    expect(body.error).toContain('a.ts');
  }, 15000);

  it('pulls that same thread once the file is clean again', async () => {
    execFileSync('git', ['checkout', '--', 'a.ts'], { cwd: repoDir, stdio: 'pipe' });

    const { status, body } = await post('/api/github/pull-comments', { sessionId });

    expect(status).toBe(200);
    expect(body.pulled).toBe(1);
    expect(body.skipped).toBe(1);
  }, 15000);
});
