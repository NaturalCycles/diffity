export interface GitHubRemote {
  owner: string;
  repo: string;
}

export interface PrReview {
  author: string;
  isBot: boolean;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED. */
  state: string;
  body: string;
  submittedAt: string;
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

export interface PrComment {
  /** The finding this came from, so a successful review can mark it as sent. */
  threadId?: string;
  filePath: string;
  side: 'LEFT' | 'RIGHT';
  startLine: number | null;
  endLine: number;
  body: string;
}

export interface ReviewSubmission {
  event: ReviewEvent;
  body: string;
  comments: PrComment[];
}

export interface ReviewResult {
  submitted: number;
  /** The findings that actually left the machine, which is not every one that was offered. */
  submittedThreadIds: string[];
  /** The forge's id for each comment it created, so a finding can be recognised by id later. */
  commentIds: { threadId: string; githubCommentId: number }[];
  skipped: number;
  failed: number;
  errors: string[];
  reviewUrl: string | null;
}

/** What `POST /api/github/pull-comments` answers. */
export interface PullCommentsResult {
  pulled: number;
  resolved: number;
  skipped: number;
  /** True when thread resolution state could not be fetched, so nothing was resolved locally. */
  resolutionUnavailable: boolean;
}
