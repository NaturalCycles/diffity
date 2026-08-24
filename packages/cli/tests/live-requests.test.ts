import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let origCwd: string;

const you = { name: 'You', type: 'user' as const };
const agent = { name: 'Agent', type: 'agent' as const };

beforeAll(() => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-live-'));
  repoDir = join(root, 'repo');
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

async function session() {
  const { findOrCreateSession } = await import('../src/session.js');
  return findOrCreateSession('work');
}

async function finding(body = 'P2: a finding') {
  const { createThread } = await import('../src/threads.js');
  const s = await session();
  return createThread(s.id, 'a.ts', 'new', 1, 1, body, agent);
}


async function drainRequests() {
  const { claimNextLiveRequest } = await import('../src/live.js');
  const s = await session();
  while (claimNextLiveRequest(s.id)) {
    // Sessions on one branch share their open threads by design, so earlier cases leave requests
    // in this queue. A case about "the next one" has to start from empty.
  }
}

describe('a comment kind', () => {
  it('is a review comment unless it says otherwise', async () => {
    const thread = await finding();

    expect(thread.comments[0].kind).toBe('review');
  });

  it('records an aside as an aside', async () => {
    const { addReply, getThread } = await import('../src/threads.js');
    const thread = await finding();

    addReply(thread.id, 'what do you mean?', you, 'aside');

    expect(getThread(thread.id)?.comments[1].kind).toBe('aside');
  });
});

describe('asking the agent for something', () => {
  it('is not requested until it is asked for', async () => {
    const { addReply, getThread } = await import('../src/threads.js');
    const thread = await finding();
    const reply = addReply(thread.id, 'just thinking aloud', you, 'aside');

    expect(getThread(thread.id)?.comments[1].liveRequestedAt).toBeNull();
    expect(reply.liveRequestedAt).toBeNull();
  });

  it('is picked up by a listener', async () => {
    const { addReply } = await import('../src/threads.js');
    const { requestLive, claimNextLiveRequest } = await import('../src/live.js');
    const s = await session();
    const thread = await finding('P2: the marker');
    const reply = addReply(thread.id, 'what do you mean by the marker?', you, 'aside');
    requestLive(reply.id);

    const claimed = claimNextLiveRequest(s.id);

    expect(claimed?.commentId).toBe(reply.id);
    expect(claimed?.threadId).toBe(thread.id);
    expect(claimed?.body).toBe('what do you mean by the marker?');
    expect(claimed?.filePath).toBe('a.ts');
  });

  // Two listeners on one session must not both act on the same question.
  it('is claimed once', async () => {
    const { addReply } = await import('../src/threads.js');
    const { requestLive, claimNextLiveRequest } = await import('../src/live.js');
    const s = await session();
    const thread = await finding();
    const reply = addReply(thread.id, 'only once please', you, 'aside');
    requestLive(reply.id);

    const first = claimNextLiveRequest(s.id);
    const second = claimNextLiveRequest(s.id);

    expect(first?.commentId).toBe(reply.id);
    expect(second).toBeNull();
  });

  it('comes in the order it was asked', async () => {
    const { addReply } = await import('../src/threads.js');
    const { requestLive, claimNextLiveRequest } = await import('../src/live.js');
    const s = await session();
    const thread = await finding();
    const first = addReply(thread.id, 'asked first', you, 'aside');
    const second = addReply(thread.id, 'asked second', you, 'aside');
    requestLive(first.id);
    requestLive(second.id);

    expect(claimNextLiveRequest(s.id)?.body).toBe('asked first');
    expect(claimNextLiveRequest(s.id)?.body).toBe('asked second');
  });

  it('says how many are still waiting', async () => {
    const { addReply } = await import('../src/threads.js');
    const { requestLive, claimNextLiveRequest, pendingLiveCount } = await import('../src/live.js');
    const s = await session();
    const thread = await finding();
    for (const body of ['one', 'two', 'three']) {
      requestLive(addReply(thread.id, body, you, 'aside').id);
    }

    expect(pendingLiveCount(s.id)).toBe(3);
    claimNextLiveRequest(s.id);
    expect(pendingLiveCount(s.id)).toBe(2);
  });

  it('is marked answered so it is not asked again', async () => {
    const { addReply, getThread } = await import('../src/threads.js');
    const { requestLive, claimNextLiveRequest, answerLiveRequest } = await import('../src/live.js');
    const s = await session();
    const thread = await finding();
    const reply = addReply(thread.id, 'answer me', you, 'aside');
    requestLive(reply.id);
    claimNextLiveRequest(s.id);

    answerLiveRequest(reply.id);

    expect(getThread(thread.id)?.comments[1].liveAnsweredAt).toBeTruthy();
  });

  it('belongs to its own session', async () => {
    const { addReply } = await import('../src/threads.js');
    const { requestLive, claimNextLiveRequest } = await import('../src/live.js');
    const thread = await finding();
    const reply = addReply(thread.id, 'in the work session', you, 'aside');
    requestLive(reply.id);

    expect(claimNextLiveRequest('some-other-session')).toBeNull();
  });
});

describe('a listener that died holding a request', () => {
  it('lets the request be claimed again', async () => {
    const { addReply, getThread } = await import('../src/threads.js');
    const { requestLive, claimNextLiveRequest, reclaimStaleLiveRequests } = await import('../src/live.js');
    const { getDb } = await import('../src/db.js');
    const s = await session();
    const thread = await finding();
    const reply = addReply(thread.id, 'nobody came back', you, 'aside');
    requestLive(reply.id);
    claimNextLiveRequest(s.id);

    // What it looks like when the agent was claimed by a process that then went away.
    getDb()
      .prepare("UPDATE comments SET live_claimed_at = datetime('now', '-30 minutes') WHERE id = ?")
      .run(reply.id);

    expect(reclaimStaleLiveRequests(10)).toBe(1);
    // Asserted on the request itself rather than on what comes back next: earlier cases leave
    // their own requests waiting, so queue position would be about them and not about this.
    expect(getThread(thread.id)?.comments[1].liveClaimedAt).toBeNull();
  });

  it('leaves a fresh claim alone', async () => {
    const { addReply } = await import('../src/threads.js');
    const { requestLive, claimNextLiveRequest, reclaimStaleLiveRequests } = await import('../src/live.js');
    const s = await session();
    const thread = await finding();
    requestLive(addReply(thread.id, 'just claimed', you, 'aside').id);
    claimNextLiveRequest(s.id);

    expect(reclaimStaleLiveRequests(10)).toBe(0);
  });
});

describe('asking about a line nobody has commented on', () => {
  it('has no finding to be about', async () => {
    const { createThread } = await import('../src/threads.js');
    const { requestLive, claimNextLiveRequest } = await import('../src/live.js');
    await drainRequests();
    const s = await session();
    const thread = createThread(
      s.id, 'a.ts', 'new', 1, 1, 'what does this do?', you, undefined, 'aside',
    );
    requestLive(thread.comments[0].id);

    const claimed = claimNextLiveRequest(s.id);

    expect(claimed?.body).toBe('what does this do?');
    expect(claimed?.findingBody).toBeNull();
  });

  it('still reports the finding when there is one', async () => {
    const { createThread, addReply } = await import('../src/threads.js');
    const { requestLive, claimNextLiveRequest } = await import('../src/live.js');
    await drainRequests();
    const s = await session();
    const thread = createThread(s.id, 'a.ts', 'new', 2, 2, 'P2: the finding', agent);
    const asked = addReply(thread.id, 'why?', you, 'aside');
    requestLive(asked.id);

    expect(claimNextLiveRequest(s.id)?.findingBody).toBe('P2: the finding');
  });
});

describe('closing a request', () => {
  // Every other command takes an 8-char prefix, so one that silently ignores one is a trap: the
  // agent reports it answered, and the page goes on saying an agent is working on it.
  it('accepts the short id the rest of the CLI accepts', async () => {
    const { addReply, getThread } = await import('../src/threads.js');
    const { requestLive, claimNextLiveRequest, answerLiveRequest } = await import('../src/live.js');
    await drainRequests();
    const s = await session();
    const thread = await finding();
    const asked = addReply(thread.id, 'answer me by prefix', you, 'aside');
    requestLive(asked.id);
    claimNextLiveRequest(s.id);

    expect(answerLiveRequest(asked.id.slice(0, 8))).toBe(true);
    expect(getThread(thread.id)?.comments[1].liveAnsweredAt).toBeTruthy();
  });

  it('says so when it matched nothing, rather than reporting success', async () => {
    const { answerLiveRequest } = await import('../src/live.js');

    expect(answerLiveRequest('no-such-comment')).toBe(false);
  });
});

describe('two sessions in one server', () => {
  // One diffity serves a whole checkout: the file browser is its own session and each ref gets
  // one, so a listener on one must not be disturbed by — or spoken for by — another.
  it('does not report a listener on one session as listening on another', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { waitForLiveRequest, liveListenerCount } = await import('../src/live.js');
    const other = findOrCreateSession('__tree__');
    const s = await session();

    const parked = waitForLiveRequest(s.id, 400);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(liveListenerCount(s.id)).toBe(1);
    expect(liveListenerCount(other.id)).toBe(0);

    await parked;
  });

  it('does not end a wait because another session was asked something', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread } = await import('../src/threads.js');
    const { requestLive, notifyLiveListeners, waitForLiveRequest } = await import('../src/live.js');
    await drainRequests();
    const other = findOrCreateSession('__tree__');
    const s = await session();

    let settled = false;
    const parked = waitForLiveRequest(s.id, 600).then(request => {
      settled = true;
      return request;
    });
    await new Promise(resolve => setTimeout(resolve, 50));

    // Something asked, but on the other session.
    const elsewhere = createThread(other.id, 'a.ts', 'new', 1, 1, 'asked over here', you, undefined, 'aside');
    requestLive(elsewhere.comments[0].id);
    notifyLiveListeners(other.id);
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(settled).toBe(false);
    expect(await parked).toBeNull();
  });
});

describe('what the server says it wrote', () => {
  // Handing back a timestamp made up by the caller meant a client comparing it with a later GET
  // was comparing two unrelated strings: the column is datetime('now'), not an ISO string.
  it('reports the stamp it actually wrote', async () => {
    const { addReply, getThread } = await import('../src/threads.js');
    const { requestLive } = await import('../src/live.js');
    const thread = await finding();
    const asked = addReply(thread.id, 'what does the stamp look like?', you, 'aside');

    const stamp = requestLive(asked.id);
    const stored = getThread(thread.id)?.comments[1].liveRequestedAt;

    expect(stamp.requestedAt).toBe(stored);
    expect(stamp.sessionId).toBeTruthy();
  });
});

describe('a listener whose connection goes away', () => {
  // Presence is a parked connection. Nothing noticed the connection closing, so `listening` kept
  // saying yes for as long as the wait had left — up to four minutes of promising an answer.
  it('stops being counted at once, not when its wait runs out', async () => {
    const { waitForLiveRequest, liveListenerCount } = await import('../src/live.js');
    // Sessions on one branch share their open threads, so an earlier case's request would be
    // claimed here and this would never park at all.
    await drainRequests();
    const s = await session();
    const controller = new AbortController();

    const parked = waitForLiveRequest(s.id, 60_000, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(liveListenerCount(s.id)).toBe(1);

    controller.abort();

    expect(await parked).toBeNull();
    expect(liveListenerCount(s.id)).toBe(0);
  });

  it('is already gone if the connection closed before it parked', async () => {
    const { waitForLiveRequest, liveListenerCount } = await import('../src/live.js');
    await drainRequests();
    const s = await session();
    const controller = new AbortController();
    controller.abort();

    expect(await waitForLiveRequest(s.id, 60_000, controller.signal)).toBeNull();
    expect(liveListenerCount(s.id)).toBe(0);
  });
});
