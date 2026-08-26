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
  /** Who opened it, which is not visible anywhere else in the page. */
  prAuthor: string;
  /** GitHub refuses to approve or request changes on your own pull request. */
  viewerDidAuthor: boolean;
  /** The description, which is where the author says what the change is for. */
  prBody: string;
  reviews: PrReview[];
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface ReviewSubmission {
  event: ReviewEvent;
  body: string;
  comments: PrComment[];
}

export interface ReviewResult {
  submitted: number;
  /** The findings that actually left the machine, which is not every one that was offered. */
  submittedThreadIds: string[];
  skipped: number;
  failed: number;
  errors: string[];
  reviewUrl: string | null;
}

export interface PrReview {
  author: string;
  isBot: boolean;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED. */
  state: string;
  body: string;
  submittedAt: string;
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
  /** The finding this came from, so a successful review can mark it as sent. */
  threadId?: string;
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
