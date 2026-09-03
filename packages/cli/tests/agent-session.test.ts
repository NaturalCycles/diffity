import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseServerSession } from '../src/agent-session.js';

describe('parseServerSession', () => {
  it('takes a session', () => {
    expect(parseServerSession('{"id":"s1","ref":"work","headHash":"abc"}')).toEqual({
      id: 's1',
      ref: 'work',
      headHash: 'abc',
    });
  });

  it("refuses an old server's HTML fallback, which arrives with a 200", () => {
    expect(parseServerSession('<!DOCTYPE html><html></html>')).toBeNull();
  });

  it('refuses a body of the wrong shape', () => {
    expect(parseServerSession('{"error":"no"}')).toBeNull();
    expect(parseServerSession('null')).toBeNull();
  });
});

describe('getSessionById', () => {
  let root: string;
  let repoDir: string;
  let origCwd: string;

  beforeAll(() => {
    origCwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), 'diffity-byid-'));
    repoDir = join(root, 'repo');
    mkdirSync(repoDir);
    execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
    process.env.DIFFITY_DATA_DIR = join(root, 'notes');
    process.chdir(repoDir);
  });

  afterAll(() => {
    process.chdir(origCwd);
    delete process.env.DIFFITY_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it('finds a session by its full id and by the 8-char prefix', async () => {
    const { findOrCreateSession, getSessionById } = await import('../src/session.js');
    const session = findOrCreateSession('work');

    expect(getSessionById(session.id)?.id).toBe(session.id);
    expect(getSessionById(session.id.slice(0, 8))?.id).toBe(session.id);
    expect(getSessionById(session.id.slice(0, 8))?.ref).toBe('work');
  });

  it('answers null for an unknown id', async () => {
    const { getSessionById } = await import('../src/session.js');

    expect(getSessionById('no-such-session')).toBeNull();
  });

  it('chases a superseded id to the session the work moved into', async () => {
    const { findOrCreateSession, getSessionById } = await import('../src/session.js');
    const { createThread } = await import('../src/threads.js');
    const before = findOrCreateSession('work');
    createThread(before.id, 'a.ts', 'new', 1, 1, 'P2: open work', { name: 'Agent', type: 'agent' });

    writeFileSync(join(repoDir, 'a.ts'), 'const a = 2;\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'move'], { cwd: repoDir, stdio: 'pipe' });
    const after = findOrCreateSession('work');

    expect(after.id).not.toBe(before.id);
    expect(getSessionById(before.id)?.id).toBe(after.id);
  });

  it('does not take a session from a server that turns out to serve another repository', async () => {
    const { createHash } = await import('node:crypto');
    const { createServer } = await import('node:http');
    const { registerInstance, readRegistry } = await import('../src/registry.js');
    const { resolveAgentSession } = await import('../src/agent-session.js');
    const { getRepoRoot } = await import('@diffity/git');

    const impostor = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'not-yours', ref: 'work', headHash: 'x', root: '/somewhere/else' }));
    });
    await new Promise<void>(resolve => impostor.listen(0, '127.0.0.1', () => resolve()));
    const port = (impostor.address() as { port: number }).port;
    const repoRoot = getRepoRoot()!;
    const repoHash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 12);
    registerInstance({ pid: process.pid, port, repoRoot, repoHash, repoName: 'repo', ref: 'work', description: '', startedAt: new Date().toISOString() });
    try {
      const session = await resolveAgentSession();
      expect(session?.id).not.toBe('not-yours');
      expect(readRegistry().find(e => e.port === port)).toBeUndefined();
    } finally {
      impostor.close();
    }
  });
});
