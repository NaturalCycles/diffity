import type { GitHubRemote } from './github.js';

/** Whether an agent is part-way through writing findings, and since when. */
export interface ReviewRun {
  inProgress: boolean;
  startedAt: string | null;
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

/** What `/api/live/status` answers: whether an agent is waiting for questions on this session. */
export interface LiveStatusResponse {
  listening: boolean;
  lastPollAt: string | null;
}
