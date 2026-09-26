import { memberOf } from './member.js';

/** Threads with this path are about the whole diff rather than any file. */
export const GENERAL_THREAD_FILE_PATH = '__general__';

export const COMMENT_SIDES = ['old', 'new'] as const;
export type CommentSide = (typeof COMMENT_SIDES)[number];
export const isCommentSide = memberOf(COMMENT_SIDES);

/**
 * What a comment is for, which decides where it can go. A review comment is the finding, and it
 * can be posted; an aside is the conversation about the review, and it is never posted.
 */
export const COMMENT_KINDS = ['review', 'aside'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];
export const isCommentKind = memberOf(COMMENT_KINDS);

export const THREAD_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];
export const isThreadStatus = memberOf(THREAD_STATUSES);

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
  /** When this finding was last sent to the forge, or null while it has never been posted. */
  submittedAt: string | null;
  submittedReviewUrl: string | null;
  submittedHeadSha: string | null;
  /** The body as it was sent, which an amendment here does not change. */
  submittedBody: string | null;
  /** The forge's id for the comment this finding went out as, or null while it has none. */
  githubCommentId: number | null;
  comments: Comment[];
}
