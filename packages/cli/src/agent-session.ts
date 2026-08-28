import { createHash } from 'node:crypto';
import type { ReviewSession } from '@diffity/api';
import { getRepoRoot } from '@diffity/git';
import { findInstanceForRepo, type RegistryEntry } from './registry.js';
import { getCurrentSession, getSessionById } from './session.js';

/** How the server tells the agent's own traffic from a page somebody is looking at. */
export const AGENT_HEADER = { 'x-diffity-agent': '1' } as const;

/** The registry's own health probe allows the same; a wedged server must not hang every command. */
const SERVER_TIMEOUT_MS = 2000;

export function findRunningInstance(): RegistryEntry | null {
  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    return null;
  }
  return findInstanceForRepo(createHash('sha256').update(repoRoot).digest('hex').slice(0, 12));
}

/**
 * An old server answers an unknown route with the page's HTML and a 200, so a body being a
 * session cannot be assumed from the status.
 */
export function parseServerSession(text: string): ReviewSession | null {
  try {
    const parsed = JSON.parse(text) as ReviewSession | null;
    if (parsed && typeof parsed.id === 'string' && typeof parsed.ref === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchServerSession(port: number): Promise<ReviewSession | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/ensure`, {
      method: 'POST',
      headers: AGENT_HEADER,
      signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    return parseServerSession(await res.text());
  } catch {
    return null;
  }
}

/**
 * What a server from before the ensure route can still answer: the info route has always named
 * this server's session. Without this, upgrading the CLI under a running server would drop every
 * command back onto the ambient file — the exact failure this module exists to end.
 */
async function fetchLegacySession(port: number): Promise<ReviewSession | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/info`, {
      headers: AGENT_HEADER,
      signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    const info = JSON.parse(await res.text()) as { sessionId?: string | null } | null;
    return info?.sessionId ? getSessionById(info.sessionId) : null;
  } catch {
    return null;
  }
}

/**
 * The session an agent command operates on.
 *
 * The running server is the authority: the ambient current-session file is rewritten by every
 * tab's info poll on this data directory, so between two agent commands it can come to name
 * somebody else's review. The file still answers when nothing is running for this repository —
 * though another worktree sharing the data directory may still be rewriting it.
 */
export async function resolveAgentSession(explicitId?: string): Promise<ReviewSession | null> {
  if (explicitId) {
    return getSessionById(explicitId);
  }

  const instance = findRunningInstance();
  if (instance) {
    const fromServer = (await fetchServerSession(instance.port)) ?? (await fetchLegacySession(instance.port));
    if (fromServer) {
      return fromServer;
    }
  }

  return getCurrentSession();
}
