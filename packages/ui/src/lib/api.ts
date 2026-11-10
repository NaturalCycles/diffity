import type {
  AdvanceResponse,
  Comment,
  CommentAuthor,
  CommentThread,
  CreateThreadRequest,
  DiffResponse,
  FileContentResponse,
  GitHubDetails,
  LiveStatusResponse,
  MovedOnRefusal,
  PullCommentsResult,
  RepoInfoResponse,
  ReplyRequest,
  ReviewRequestResponse,
  ReviewResult,
  ReviewSubmission,
  ThreadStatus,
  Tour,
} from '@diffity/api';
import { apiPath } from './base';
import { apiRequest } from './request';

export type {
  GitHubDetails,
  MovedOn,
  PrComment,
  ReviewEvent,
  ReviewRun,
  ReviewState,
  Tour,
  TourStep,
} from '@diffity/api';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiRequest(apiPath(url), init);
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return res.json();
}

async function apiVoid(url: string, init?: RequestInit): Promise<void> {
  const res = await apiRequest(apiPath(url), init);
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
}

async function errorMessage(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  return json?.error || `HTTP ${res.status}`;
}

function buildUrl(path: string, params?: Record<string, string | undefined>): string {
  if (!params) {
    return path;
  }
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      searchParams.set(key, value);
    }
  }
  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
}

export function fetchDiff(hideWhitespace: boolean): Promise<DiffResponse> {
  return apiFetch(buildUrl('/api/diff', { whitespace: hideWhitespace ? 'hide' : undefined }));
}

export function fetchRepoInfo(): Promise<RepoInfoResponse> {
  return apiFetch('/api/info');
}

export async function fetchThreads(sessionId: string, status?: ThreadStatus): Promise<CommentThread[]> {
  const res = await apiRequest(apiPath(buildUrl('/api/threads', { session: sessionId, status })));
  if (!res.ok) {
    return [];
  }
  return res.json();
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function createThread(data: CreateThreadRequest): Promise<CommentThread> {
  return apiFetch('/api/threads', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });
}

export function replyToThread(threadId: string, body: string, author: CommentAuthor, ask?: boolean): Promise<Comment> {
  const request: ReplyRequest = { body, author, ...(ask ? { ask } : {}) };
  return apiFetch(`/api/threads/${threadId}/reply`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(request),
  });
}

export function updateThreadStatus(threadId: string, status: ThreadStatus, summary?: string): Promise<void> {
  return apiVoid(`/api/threads/${threadId}/status`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status, summary }),
  });
}

export function deleteAllThreads(sessionId: string): Promise<void> {
  return apiVoid('/api/threads', {
    method: 'DELETE',
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId }),
  });
}

export function deleteThread(threadId: string): Promise<void> {
  return apiVoid(`/api/threads/${threadId}`, { method: 'DELETE' });
}

export function editComment(commentId: string, body: string): Promise<void> {
  return apiVoid(`/api/comments/${commentId}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ body }),
  });
}

export function deleteComment(commentId: string): Promise<void> {
  return apiVoid(`/api/comments/${commentId}`, { method: 'DELETE' });
}

export async function fetchFileContent(filePath: string): Promise<string[]> {
  const json = await apiFetch<FileContentResponse>(`/api/file/${encodeURIComponent(filePath)}`);
  return json.content;
}

export async function fetchGitHubDetails(): Promise<GitHubDetails | null> {
  const res = await apiRequest(apiPath('/api/github/details'));
  if (!res.ok) {
    return null;
  }
  return res.json();
}

/** The pull request has moved on since the session's head, and the review was not posted. */
export class MovedOnError extends Error {
  constructor(readonly headSha: string, readonly sessionHeadSha: string, message: string) {
    super(message);
  }
}

export async function createReviewOnGitHub(review: ReviewSubmission): Promise<ReviewResult> {
  const res = await apiRequest(apiPath('/api/github/create-review'), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(review),
  });
  if (res.ok) {
    return res.json();
  }
  const json = (await res.json().catch(() => null)) as Partial<MovedOnRefusal> | null;
  if (res.status === 409 && json?.code === 'moved_on' && json.headSha && json.sessionHeadSha) {
    throw new MovedOnError(json.headSha, json.sessionHeadSha, json.error ?? 'The pull request has moved on');
  }
  throw new Error(json?.error || `HTTP ${res.status}`);
}

export function advanceSession(): Promise<AdvanceResponse> {
  return apiFetch('/api/advance', { method: 'POST' });
}

export function pullCommentsFromGitHub(sessionId: string): Promise<PullCommentsResult> {
  return apiFetch('/api/github/pull-comments', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId }),
  });
}

export function fetchLiveStatus(): Promise<LiveStatusResponse> {
  return apiFetch('/api/live/status');
}

export function requestReview(): Promise<ReviewRequestResponse> {
  return apiFetch('/api/review-request', { method: 'POST' });
}

export function fetchTours(sessionId: string): Promise<Tour[]> {
  return apiFetch(`/api/tours?session=${encodeURIComponent(sessionId)}`);
}
