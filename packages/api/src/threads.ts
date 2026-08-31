import { memberOf } from './member.js';

/** Threads with this path are about the whole diff rather than any file. */
export const GENERAL_THREAD_FILE_PATH = '__general__';

/**
 * Marks a request as the agent's own traffic. A reader's polls steer which session the agent
 * follows and whether anyone is watching; requests carrying this header steer neither.
 */
export const AGENT_TRAFFIC_HEADER = 'x-diffity-agent';

export const COMMENT_SIDES = ['old', 'new'] as const;
export type CommentSide = (typeof COMMENT_SIDES)[number];
export const isCommentSide = memberOf(COMMENT_SIDES);

/**
 * What a comment is for, which decides where it can go. A review comment is the finding, and it
 * can be posted; an aside is the conversation about the review, and it stays on this machine.
 */
export const COMMENT_KINDS = ['review', 'aside'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];
export const isCommentKind = memberOf(COMMENT_KINDS);

export const THREAD_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];
export const isThreadStatus = memberOf(THREAD_STATUSES);

/** What the reader pressed: a question, or a request for a change. */
export const LIVE_INTENTS = ['ask', 'act'] as const;
export type LiveIntent = (typeof LIVE_INTENTS)[number];
export const isLiveIntent = memberOf(LIVE_INTENTS);

export const AUTHOR_TYPES = ['user', 'agent'] as const;
export type AuthorType = (typeof AUTHOR_TYPES)[number];
export const isAuthorType = memberOf(AUTHOR_TYPES);

export interface CommentAuthor {
  name: string;
  type: AuthorType;
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
