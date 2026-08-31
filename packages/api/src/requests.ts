import {
  AUTHOR_TYPES,
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

/**
 * What a parser answers: the typed request, or what is wrong with the body. Parsing happens at
 * the server boundary, so the message is written for whoever sent the request.
 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

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

// Hand-rolled rather than a schema library: the wire has one small shape per route, and a field
// reader that throws keeps each parser a flat object literal.

class FieldError extends Error {}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FieldError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseWith<T>(body: unknown, build: (obj: Record<string, unknown>) => T): ParseResult<T> {
  try {
    return { ok: true, value: build(record(body, 'request body')) };
  } catch (error) {
    if (error instanceof FieldError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

function str(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new FieldError(`${label} must be a non-empty string`);
  }
  return value;
}

/** For the few fields where empty means something, like the editor path that means the repo root. */
function anyStr(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new FieldError(`${label} must be a string`);
  }
  return value;
}

function optStr(value: unknown, label: string): string | undefined {
  return value == null ? undefined : anyStr(value, label);
}

function int(value: unknown, label: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new FieldError(`${label} must be an integer >= ${min}`);
  }
  return value;
}

function optInt(value: unknown, label: string, min: number): number | undefined {
  return value == null ? undefined : int(value, label, min);
}

function optBool(value: unknown, label: string): boolean | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new FieldError(`${label} must be a boolean`);
  }
  return value;
}

function member<T extends string>(value: unknown, label: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new FieldError(`${label} must be one of: ${values.join(', ')}`);
  }
  return value as T;
}

function optMember<T extends string>(
  value: unknown,
  label: string,
  values: readonly T[],
): T | undefined {
  return value == null ? undefined : member(value, label, values);
}

/** Built from the fields it names, so nothing else in the request object reaches storage. */
function author(value: unknown, label: string): CommentAuthor {
  const obj = record(value, label);
  return {
    name: str(obj.name, `${label}.name`),
    type: member(obj.type, `${label}.type`, AUTHOR_TYPES),
    avatarUrl: optStr(obj.avatarUrl, `${label}.avatarUrl`),
  };
}

export function parseCreateThreadRequest(body: unknown): ParseResult<CreateThreadRequest> {
  return parseWith(body, obj => ({
    sessionId: str(obj.sessionId, 'sessionId'),
    filePath: str(obj.filePath, 'filePath'),
    side: member(obj.side, 'side', COMMENT_SIDES),
    // Line 0 is real: a general comment is about the whole diff and sits on no line.
    startLine: int(obj.startLine, 'startLine', 0),
    endLine: int(obj.endLine, 'endLine', 0),
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
    startLine: int(obj.startLine, 'startLine', 0),
    endLine: int(obj.endLine, 'endLine', 0),
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
    startLine: obj.startLine == null ? null : int(obj.startLine, `${label}.startLine`, 1),
    endLine: int(obj.endLine, `${label}.endLine`, 1),
    body: str(obj.body, `${label}.body`),
  };
}
