import type { GitHubRemote } from './github.js';

/**
 * Where a session's review stands. `queued` waits for an agent to take it, `stale` waited too long
 * for one, `claimed` is taken by an agent that has not started, `reviewing` is an agent part-way
 * through writing findings.
 */
export type ReviewState = 'none' | 'queued' | 'stale' | 'claimed' | 'reviewing' | 'done';

export interface ReviewRun {
  state: ReviewState;
  queuedAt: string | null;
  startedAt: string | null;
  doneAt: string | null;
  note: string;
}

/** What `/api/info` answers. */
export interface RepoInfoResponse {
  name: string;
  branch: string;
  root: string;
  description: string;
  sessionId: string;
  review?: ReviewRun | null;
  github: GitHubRemote | null;
}

/**
 * What `/api/live/status` answers: whether an agent is waiting for questions on this session, or,
 * on the Sessions page, for anything of the user's.
 */
export interface LiveStatusResponse {
  listening: boolean;
  lastPollAt: string | null;
  /** Requests an agent has taken and not answered yet; it counts as listening while it works on them. */
  working: number;
}
