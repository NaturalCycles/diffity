import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let origCwd: string;
let origHome: string | undefined;
let stub: Server | null = null;

function listen(server: Server): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

/** What `registerInstance` writes, pointed at a stub server this test controls. */
function registerStub(port: number): void {
  const repoHash = createHash('sha256').update(repoDir).digest('hex').slice(0, 12);
  const dir = join(root, 'home', '.diffity');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'registry.json'),
    JSON.stringify([{
      pid: process.pid,
      port,
      repoRoot: repoDir,
      repoHash,
      repoName: 'repo',
      ref: 'work',
      description: 'test',
      startedAt: new Date().toISOString(),
    }]),
  );
}

beforeAll(() => {
  origCwd = process.cwd();
  origHome = process.env.HOME;
  root = mkdtempSync(join(tmpdir(), 'diffity-precedence-'));
  repoDir = join(root, 'repo');
  mkdirSync(repoDir);
  mkdirSync(join(root, 'home'));
  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir, stdio: 'pipe' });
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
  // The registry lives under the home directory, so the test owns a fake one.
  process.env.HOME = join(root, 'home');
  process.chdir(repoDir);
});

afterAll(() => {
  stub?.close();
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  if (origHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = origHome;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('resolveAgentSession', () => {
  it('lets an explicit id win without asking anybody', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { resolveAgentSession } = await import('../src/agent-session.js');
    const session = findOrCreateSession('main');

    const resolved = await resolveAgentSession(session.id);

    expect(resolved?.id).toBe(session.id);
  });

  it("takes the running server's session over the ambient file", async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { resolveAgentSession } = await import('../src/agent-session.js');
    // The ambient file now names the work session; the stub server answers with another.
    findOrCreateSession('work');
    const other = findOrCreateSession('main');

    stub = createServer((req, res) => {
      if (req.url === '/api/sessions/ensure' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(other));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    registerStub(await listen(stub));

    const resolved = await resolveAgentSession();

    expect(resolved?.id).toBe(other.id);
    stub.close();
    stub = null;
  });

  it("falls back to an old server's info route when the ensure route is not there", async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { resolveAgentSession } = await import('../src/agent-session.js');
    findOrCreateSession('work');
    const named = findOrCreateSession('main');

    stub = createServer((req, res) => {
      if (req.url === '/api/info' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'repo', sessionId: named.id }));
        return;
      }
      // An old server answers an unknown route with the page and a 200.
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html></html>');
    });
    registerStub(await listen(stub));

    const resolved = await resolveAgentSession();

    expect(resolved?.id).toBe(named.id);
    stub.close();
    stub = null;
  });

  it('trusts the ambient file when the registered server is gone', async () => {
    const { findOrCreateSession, getCurrentSession } = await import('../src/session.js');
    const { resolveAgentSession } = await import('../src/agent-session.js');
    findOrCreateSession('work');

    const closed = createServer(() => {});
    const port = await listen(closed);
    await new Promise(resolve => closed.close(resolve));
    registerStub(port);

    const resolved = await resolveAgentSession();

    expect(resolved?.id).toBe(getCurrentSession()?.id);
  });
});
