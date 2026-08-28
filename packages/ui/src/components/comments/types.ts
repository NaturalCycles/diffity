import type { CommentAuthor, CommentSide, CommentThread } from '@diffity/api';
import type { TourMark } from '../../lib/tour-marks';

export { GENERAL_THREAD_FILE_PATH } from '@diffity/api';
export type {
  Comment,
  CommentAuthor,
  CommentKind,
  CommentSide,
  CommentThread,
  ThreadStatus,
} from '@diffity/api';

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
  onActThread?: (filePath: string, side: CommentSide, startLine: number, endLine: number, body: string, author: CommentAuthor) => void;
  onActReply?: (threadId: string, body: string, author: CommentAuthor) => void;
  askIsHeard?: boolean;
  tourMarks?: TourMark[];
  activeStepIndex?: number;
  onTourMarkClick?: (stepIndex: number) => void;
}
