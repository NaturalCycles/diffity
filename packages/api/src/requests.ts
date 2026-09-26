import {
  COMMENT_KINDS,
  COMMENT_SIDES,
  THREAD_STATUSES,
  type CommentAuthor,
  type CommentKind,
  type CommentSide,
  type ThreadStatus,
} from './threads.js';
import {
  PR_COMMENT_SIDES,
  REVIEW_EVENTS,
  type PrComment,
  type ReviewSubmission,
} from './github.js';
import {
  FieldError,
  anyStr,
  author,
  int,
  lineRange,
  member,
  optMember,
  optStr,
  parseWith,
  record,
  str,
  type ParseResult,
} from './parse.js';

export type { ParseResult } from './parse.js';

/** What `POST /api/threads` accepts. */
export interface CreateThreadRequest {
  sessionId: string;
  filePath: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
  body: string;
  author: CommentAuthor;
  anchorContent?: string;
  /** An aside starts a conversation rather than a finding, and is never posted. Absent means review. */
  kind?: CommentKind;
}

/** What `POST /api/threads/:id/reply` accepts. */
export interface ReplyRequest {
  body: string;
  author: CommentAuthor;
  kind?: CommentKind;
}

/** What `PATCH /api/threads/:id/status` accepts. */
export interface UpdateThreadStatusRequest {
  status: ThreadStatus;
  summary?: string;
}

/** What `DELETE /api/threads` accepts. */
export interface DeleteThreadsRequest {
  sessionId: string;
}

/** What `PATCH /api/comments/:id` accepts. */
export interface EditCommentRequest {
  body: string;
}

/** What `POST /api/github/pull-comments` accepts. */
export interface PullCommentsRequest {
  sessionId: string;
}

export function parseCreateThreadRequest(body: unknown): ParseResult<CreateThreadRequest> {
  return parseWith(body, obj => ({
    sessionId: str(obj.sessionId, 'sessionId'),
    filePath: str(obj.filePath, 'filePath'),
    side: member(obj.side, 'side', COMMENT_SIDES),
    // Line 0 is real: a general comment is about the whole diff and sits on no line.
    ...lineRange(obj, 0),
    body: str(obj.body, 'body'),
    author: author(obj.author, 'author'),
    anchorContent: optStr(obj.anchorContent, 'anchorContent'),
    kind: optMember(obj.kind, 'kind', COMMENT_KINDS),
  }));
}

export function parseReplyRequest(body: unknown): ParseResult<ReplyRequest> {
  return parseWith(body, obj => ({
    body: str(obj.body, 'body'),
    author: author(obj.author, 'author'),
    kind: optMember(obj.kind, 'kind', COMMENT_KINDS),
  }));
}

export function parseUpdateThreadStatusRequest(body: unknown): ParseResult<UpdateThreadStatusRequest> {
  return parseWith(body, obj => ({
    status: member(obj.status, 'status', THREAD_STATUSES),
    summary: optStr(obj.summary, 'summary'),
  }));
}

export function parseDeleteThreadsRequest(body: unknown): ParseResult<DeleteThreadsRequest> {
  return parseWith(body, obj => ({
    sessionId: str(obj.sessionId, 'sessionId'),
  }));
}

export function parseEditCommentRequest(body: unknown): ParseResult<EditCommentRequest> {
  return parseWith(body, obj => ({
    body: str(obj.body, 'body'),
  }));
}

export function parsePullCommentsRequest(body: unknown): ParseResult<PullCommentsRequest> {
  return parseWith(body, obj => ({
    sessionId: str(obj.sessionId, 'sessionId'),
  }));
}

export function parseReviewSubmission(body: unknown): ParseResult<ReviewSubmission> {
  return parseWith(body, obj => ({
    event: member(obj.event, 'event', REVIEW_EVENTS),
    body: obj.body == null ? '' : anyStr(obj.body, 'body'),
    comments: prComments(obj.comments),
  }));
}

function prCommentStartLine(obj: Record<string, unknown>, label: string): number | null {
  if (obj.startLine == null) {
    return null;
  }
  const startLine = int(obj.startLine, `${label}.startLine`, 1);
  const endLine = typeof obj.endLine === 'number' ? obj.endLine : startLine;
  if (endLine < startLine) {
    throw new FieldError(`${label}.endLine must not be before ${label}.startLine`);
  }
  return startLine;
}

function prComments(value: unknown): PrComment[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new FieldError('comments must be an array');
  }
  return value.map((item, index) => prComment(item, `comments[${index}]`));
}

function prComment(value: unknown, label: string): PrComment {
  const obj = record(value, label);
  return {
    threadId: optStr(obj.threadId, `${label}.threadId`),
    filePath: str(obj.filePath, `${label}.filePath`),
    side: member(obj.side, `${label}.side`, PR_COMMENT_SIDES),
    // Null start means a single-line comment; the forge lines themselves start at 1.
    startLine: prCommentStartLine(obj, label),
    endLine: int(obj.endLine, `${label}.endLine`, 1),
    body: str(obj.body, `${label}.body`),
  };
}
