import { createHash } from 'node:crypto';
import type { ReviewSession } from '@diffity/api';
import { getRepoRoot } from '@diffity/git';
import { findInstanceForRepo, type RegistryEntry } from './registry.js';
import { getCurrentSession, getSessionById } from './session.js';

/** So the server does not count the agent's own traffic as a window being open. */
export const AGENT_HEADER = { 'x-diffity-agent': '1' } as const;

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
 * The session an agent command operates on.
 *
 * The running server is the authority: the ambient current-session file is rewritten by every
 * tab's info poll on this data directory, so between two agent commands it can come to name
 * somebody else's review. The file still answers when nothing is running, which is also the only
 * time it can be trusted.
 */
export async function resolveAgentSession(explicitId?: string): Promise<ReviewSession | null> {
  if (explicitId) {
    return getSessionById(explicitId);
  }

  const instance = findRunningInstance();
  if (instance) {
    const fromServer = await fetchServerSession(instance.port);
    if (fromServer) {
      return fromServer;
    }
  }

  return getCurrentSession();
}
