import {
  COMMENT_KINDS,
  COMMENT_SIDES,
  LIVE_INTENTS,
  THREAD_STATUSES,
  type CommentAuthor,
  type CommentKind,
  type CommentSide,
  type LiveIntent,
  type ThreadStatus,
} from './threads.js';
import { TOUR_STATUSES, type TourStatus } from './tours.js';
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
  optBool,
  optInt,
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
  /** Ask the agent to answer, amend or act on it. Only an aside can. */
  live?: boolean;
  /** A question, or a request for a change. Absent is a question. */
  intent?: LiveIntent;
}

/** What `POST /api/threads/:id/reply` accepts. */
export interface ReplyRequest {
  body: string;
  author: CommentAuthor;
  kind?: CommentKind;
  live?: boolean;
  intent?: LiveIntent;
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

/** What `POST /api/tours` accepts. */
export interface CreateTourRequest {
  sessionId: string;
  topic: string;
  body?: string;
}

/** What `POST /api/tours/:id/steps` accepts. */
export interface AddTourStepRequest {
  filePath: string;
  startLine: number;
  endLine: number;
  body?: string;
  annotation?: string;
}

/** What `PATCH /api/tours/:id` accepts. */
export interface UpdateTourStatusRequest {
  status: TourStatus;
}

/** What `POST /api/revert-file` accepts. */
export interface RevertFileRequest {
  filePath: string;
  isUntracked?: boolean;
}

/** What `POST /api/revert-hunk` accepts. */
export interface RevertHunkRequest {
  patch: string;
}

/** What `POST /api/open-in-editor` accepts. An empty path means the repository root. */
export interface OpenInEditorRequest {
  filePath: string;
  line?: number;
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
    live: optBool(obj.live, 'live'),
    intent: optMember(obj.intent, 'intent', LIVE_INTENTS),
  }));
}

export function parseReplyRequest(body: unknown): ParseResult<ReplyRequest> {
  return parseWith(body, obj => ({
    body: str(obj.body, 'body'),
    author: author(obj.author, 'author'),
    kind: optMember(obj.kind, 'kind', COMMENT_KINDS),
    live: optBool(obj.live, 'live'),
    intent: optMember(obj.intent, 'intent', LIVE_INTENTS),
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

export function parseCreateTourRequest(body: unknown): ParseResult<CreateTourRequest> {
  return parseWith(body, obj => ({
    sessionId: str(obj.sessionId, 'sessionId'),
    topic: str(obj.topic, 'topic'),
    body: optStr(obj.body, 'body'),
  }));
}

export function parseAddTourStepRequest(body: unknown): ParseResult<AddTourStepRequest> {
  return parseWith(body, obj => ({
    filePath: str(obj.filePath, 'filePath'),
    ...lineRange(obj, 0),
    body: optStr(obj.body, 'body'),
    annotation: optStr(obj.annotation, 'annotation'),
  }));
}

export function parseUpdateTourStatusRequest(body: unknown): ParseResult<UpdateTourStatusRequest> {
  return parseWith(body, obj => ({
    status: member(obj.status, 'status', TOUR_STATUSES),
  }));
}

export function parseRevertFileRequest(body: unknown): ParseResult<RevertFileRequest> {
  return parseWith(body, obj => ({
    filePath: str(obj.filePath, 'filePath'),
    isUntracked: optBool(obj.isUntracked, 'isUntracked'),
  }));
}

export function parseRevertHunkRequest(body: unknown): ParseResult<RevertHunkRequest> {
  return parseWith(body, obj => ({
    patch: str(obj.patch, 'patch'),
  }));
}

export function parseOpenInEditorRequest(body: unknown): ParseResult<OpenInEditorRequest> {
  return parseWith(body, obj => ({
    filePath: anyStr(obj.filePath, 'filePath'),
    line: optInt(obj.line, 'line', 1),
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
