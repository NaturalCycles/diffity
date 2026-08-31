import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let origCwd: string;
let origPath: string | undefined;
let port: number;
let close: () => void;

// A fake gh ahead on PATH whose `pr view` takes FAKE_GH_PR_DELAY seconds, so the test decides
// how slow the forge is. Everything else it is asked answers instantly.
function writeFakeGh(dir: string): void {
  writeFileSync(join(dir, 'gh'), `#!/bin/sh
case "$1 $2" in
  "--version ") echo "gh version 2.0.0"; exit 0 ;;
  "auth status") exit 0 ;;
  "pr view")
    sleep "\${FAKE_GH_PR_DELAY:-0}"
    echo '{"number":1,"title":"Slow forge","url":"https://github.com/o/r/pull/1","headRefOid":"abc123","createdAt":"2026-01-01T00:00:00Z","author":{"login":"me"},"body":""}'
    exit 0 ;;
  "api user") echo "me"; exit 0 ;;
  "api repos/o/r/pulls/1/comments") if [ "$3" = "--jq" ]; then echo 0; else echo "[]"; fi; exit 0 ;;
  "api repos/o/r/pulls/1/reviews") echo "[]"; exit 0 ;;
  *) echo "[]"; exit 0 ;;
esac
`);
  chmodSync(join(dir, 'gh'), 0o755);
}

async function timed(path: string): Promise<{ status: number; ms: number }> {
  const before = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { 'x-diffity-agent': '1' },
  });
  await res.text();
  return { status: res.status, ms: Date.now() - before };
}

beforeAll(async () => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-ghasync-'));
  repoDir = join(root, 'repo');
  mkdirSync(repoDir);

  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  const git = (args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 'T']);
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 2;\n');
  git(['remote', 'add', 'origin', 'https://github.com/o/r.git']);

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
  delete process.env.FAKE_GH_PR_DELAY;
  if (origPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = origPath;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('a slow forge', () => {
  it('does not stall the rest of the server', async () => {
    process.env.FAKE_GH_PR_DELAY = '2';

    const details = fetch(`http://127.0.0.1:${port}/api/github/details`, {
      headers: { 'x-diffity-agent': '1' },
    });
    // The timer's own lateness is what discriminates: a synchronous gh boundary starves this
    // 200ms timer for the full two seconds, because the block elapses before any timer can fire.
    const before = Date.now();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(Date.now() - before).toBeLessThan(1200);

    const info = await timed('/api/info');
    expect(info.status).toBe(200);
    expect(info.ms).toBeLessThan(1000);

    const answered = await details;
    const body = await answered.json();
    expect(body.prNumber).toBe(1);
    expect(body.prTitle).toBe('Slow forge');
  }, 15000);

  it('still answers the details themselves', async () => {
    process.env.FAKE_GH_PR_DELAY = '0';

    const res = await fetch(`http://127.0.0.1:${port}/api/github/details`, {
      headers: { 'x-diffity-agent': '1' },
    });
    const body = await res.json();

    expect(body.prNumber).toBe(1);
    expect(body.viewerDidAuthor).toBe(true);
    expect(body.commentCount).toBe(0);
    expect(body.reviews).toEqual([]);
  }, 15000);
});
