import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let origCwd: string;
let port: number;
let close: () => void;

beforeAll(async () => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-idle-'));
  repoDir = join(root, 'repo');
  mkdirSync(repoDir);
  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir, stdio: 'pipe' });
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 2;\n');
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
  rmSync(root, { recursive: true, force: true });
});

// The decision itself is unit-tested; what this pins is that the facts the server feeds it are the
// real ones, and read off the same clock.
describe('the facts the server judges itself by', () => {
  it('says nobody has ever opened it before a page arrives', async () => {
    const { viewerSnapshot } = await import('../src/viewers.js');

    expect(viewerSnapshot().everSeen).toBe(false);
  });

  it('says a page is present, and not gone, while it beats', async () => {
    const { viewerSnapshot, viewerHasGone, viewerIsPresent, awakeMs } = await import('../src/viewers.js');
    await fetch(`http://127.0.0.1:${port}/api/viewer`, { method: 'POST' });

    expect(viewerIsPresent(viewerSnapshot(), awakeMs())).toBe(true);
    expect(viewerHasGone(viewerSnapshot(), awakeMs())).toBe(false);
  });

  it('says it has gone the moment the page says so', async () => {
    const { viewerSnapshot, viewerHasGone, awakeMs } = await import('../src/viewers.js');
    await fetch(`http://127.0.0.1:${port}/api/viewer`, { method: 'POST' });
    await fetch(`http://127.0.0.1:${port}/api/viewer/gone`, { method: 'POST' });

    expect(viewerHasGone(viewerSnapshot(), awakeMs())).toBe(true);
  });

  // What a suspended laptop does to the wall clock, and must not do to this.
  it('does not age while the machine is asleep', async () => {
    const { noteViewerSeen, viewerSnapshot, viewerHasGone, awakeMs, VIEWER_IDLE_MS } = await import('../src/viewers.js');
    noteViewerSeen();

    // Eight hours of wall clock go by; the monotonic clock does not count suspended time, so the
    // reader whose tab is still open is still there.
    const eightHoursOfWallClock = awakeMs() + 8 * 3_600_000;
    expect(viewerHasGone(viewerSnapshot(), awakeMs())).toBe(false);
    expect(eightHoursOfWallClock - awakeMs()).toBeGreaterThan(VIEWER_IDLE_MS);
  });
});
