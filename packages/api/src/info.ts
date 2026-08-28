import type { GitHubRemote } from './github.js';

/** Whether an agent is part-way through writing findings, and since when. */
export interface ReviewRun {
  inProgress: boolean;
  startedAt: string | null;
  note: string;
}

export interface RefCapabilities {
  reviews: boolean;
  revert: boolean;
  staleness: boolean;
}

/** What `/api/info` and `/api/tree/info` answer. The tree has no review run to speak of. */
export interface RepoInfoResponse {
  name: string;
  branch: string;
  root: string;
  description: string;
  capabilities: RefCapabilities;
  sessionId: string | null;
  review?: ReviewRun | null;
  github: GitHubRemote | null;
  editor: 'vscode' | null;
}
