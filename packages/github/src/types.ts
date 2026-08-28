export type {
  GitHubRemote,
  GitHubDetails,
  PrComment,
  PrReview,
  ReviewEvent,
  ReviewResult,
  ReviewSubmission,
} from '@diffity/api';

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
  /** The forge's id for the thread's first comment, which is what identifies the thread here. */
  firstCommentId: number;
  comments: PulledThreadComment[];
}

export interface PushResult {
  pushed: number;
  skipped: number;
  failed: number;
  errors: string[];
}
