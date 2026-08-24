import type { TourMark } from '../../lib/tour-marks';

export const GENERAL_THREAD_FILE_PATH = '__general__';

/**
 * What a comment is for, which decides where it can go. A review comment is the finding, and it can
 * be posted; an aside is the conversation about the review, and it stays on this machine. A comment
 * written before kinds existed has none, and is a review comment.
 */
export type CommentKind = 'review' | 'aside';

export interface CommentAuthor {
  name: string;
  avatarUrl?: string;
  type: 'user' | 'agent';
}

export interface Comment {
  id: string;
  author: CommentAuthor;
  body: string;
  /** Absent on anything written before kinds existed, which means it is a review comment. */
  kind?: CommentKind;
  createdAt: string;
  /** Set when an aside asked the agent for something, and as that request is picked up and answered. */
  liveRequestedAt?: string | null;
  liveClaimedAt?: string | null;
  liveAnsweredAt?: string | null;
}

export type CommentSide = 'old' | 'new';

export type ThreadStatus = 'open' | 'resolved' | 'dismissed';

export interface CommentThread {
  id: string;
  filePath: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
  comments: Comment[];
  status: ThreadStatus;
  anchorContent?: string;
  updatedAt?: string;
  /** Set once this finding has been sent to the forge. Sending is not resolving. */
  submittedAt?: string | null;
  sessionId?: string;
}

export const DEFAULT_AUTHOR: CommentAuthor = { name: 'You', type: 'user' };

export function isThreadResolved(thread: CommentThread): boolean {
  return thread.status === 'resolved' || thread.status === 'dismissed';
}

export interface LineSelection {
  filePath: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
}

export interface LineRenderProps {
  isLineSelected?: (line: number, side: CommentSide) => boolean;
  onLineMouseDown?: (line: number, side: CommentSide, shiftKey?: boolean) => void;
  onLineMouseEnter?: (line: number, side: CommentSide) => void;
  onCommentClick?: (line: number, side: CommentSide) => void;
  threads?: CommentThread[];
  pendingSelection?: LineSelection | null;
  currentAuthor?: CommentAuthor;
  onAddThread?: (filePath: string, side: CommentSide, startLine: number, endLine: number, body: string, author: CommentAuthor) => void;
  onCancelPending?: () => void;
  filePath?: string;
  onReply?: (threadId: string, body: string, author: CommentAuthor) => void;
  onResolve?: (threadId: string) => void;
  onUnresolve?: (threadId: string) => void;
  onEditComment?: (commentId: string, body: string) => void;
  onDeleteComment?: (threadId: string, commentId: string) => void;
  onDeleteThread?: (threadId: string) => void;
  getOriginalCode?: (side: CommentSide, startLine: number, endLine: number) => string;
  /** Hands a new comment or a reply to the agent, rather than leaving it for the code's author. */
  onAskThread?: (filePath: string, side: CommentSide, startLine: number, endLine: number, body: string, author: CommentAuthor) => void;
  onAskReply?: (threadId: string, body: string, author: CommentAuthor) => void;
  askIsHeard?: boolean;
  tourMarks?: TourMark[];
  activeStepIndex?: number;
  onTourMarkClick?: (stepIndex: number) => void;
}
