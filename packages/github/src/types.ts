export interface GitHubRemote {
  owner: string;
  repo: string;
}

export interface GitHubDetails {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  prCreatedAt: string;
  headSha: string;
  commentCount: number;
}

export interface PrBase {
  /** The base branch's name, for display. */
  name: string;
  /**
   * The commit the pull request is based on. The diff must be taken from this, not from the
   * local branch of the same name, which is usually behind the remote.
   */
  oid: string;
}

export interface PulledThreadComment {
  body: string;
  authorName: string;
  authorType: 'user' | 'agent';
  createdAt: string;
}

export interface PulledThread {
  filePath: string;
  side: 'old' | 'new';
  startLine: number;
  endLine: number;
  comments: PulledThreadComment[];
}

export interface PrComment {
  filePath: string;
  side: 'LEFT' | 'RIGHT';
  startLine: number | null;
  endLine: number;
  body: string;
}

export interface PushResult {
  pushed: number;
  skipped: number;
  failed: number;
  errors: string[];
}
