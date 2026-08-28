/** Threads with this path are about the whole diff rather than any file. */
export const GENERAL_THREAD_FILE_PATH = '__general__';

export type CommentSide = 'old' | 'new';

/**
 * What a comment is for, which decides where it can go. A review comment is the finding, and it
 * can be posted; an aside is the conversation about the review, and it stays on this machine.
 */
export type CommentKind = 'review' | 'aside';

export type ThreadStatus = 'open' | 'resolved' | 'dismissed';

/** What the reader pressed: a question, or a request for a change. */
export type LiveIntent = 'ask' | 'act';

export interface CommentAuthor {
  name: string;
  type: 'user' | 'agent';
  avatarUrl?: string;
}

export interface Comment {
  id: string;
  author: CommentAuthor;
  body: string;
  kind: CommentKind;
  createdAt: string;
  /** Set when an aside asked the agent for something, and as that request is picked up and answered. */
  liveRequestedAt: string | null;
  liveIntent: LiveIntent | null;
  liveClaimedAt: string | null;
  liveAnsweredAt: string | null;
}

export interface CommentThread {
  id: string;
  sessionId: string;
  filePath: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
  status: ThreadStatus;
  anchorContent: string | null;
  createdAt: string;
  updatedAt: string;
  /** When this finding was last sent to the forge, or null while it has never left the machine. */
  submittedAt: string | null;
  submittedReviewUrl: string | null;
  submittedHeadSha: string | null;
  /** The body as it was sent, which an amendment here does not change. */
  submittedBody: string | null;
  /** The forge's id for the comment this finding went out as, or null while it has none. */
  githubCommentId: number | null;
  comments: Comment[];
}
