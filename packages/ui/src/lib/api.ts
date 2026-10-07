import type {
  Comment,
  CommentAuthor,
  CommentThread,
  CreateThreadRequest,
  DiffResponse,
  FileContentResponse,
  GitHubDetails,
  LiveStatusResponse,
  PullCommentsResult,
  RepoInfoResponse,
  ReplyRequest,
  ReviewResult,
  ReviewRun,
  ReviewSubmission,
  ThreadStatus,
  Tour,
} from '@diffity/api';
import { apiPath } from './base';

export type {
  GitHubDetails,
  PrComment,
  ReviewEvent,
  ReviewRun,
  ReviewState,
  Tour,
  TourStep,
} from '@diffity/api';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiPath(url), init);
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return res.json();
}

async function apiVoid(url: string, init?: RequestInit): Promise<void> {
  const res = await fetch(apiPath(url), init);
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
  const res = await fetch(apiPath(buildUrl('/api/threads', { session: sessionId, status })));
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
  const res = await fetch(apiPath('/api/github/details'));
  if (!res.ok) {
    return null;
  }
  return res.json();
}

export function createReviewOnGitHub(review: ReviewSubmission): Promise<ReviewResult> {
  return apiFetch('/api/github/create-review', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(review),
  });
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

export function requestReview(): Promise<ReviewRun> {
  return apiFetch('/api/review-request', { method: 'POST' });
}

export function fetchTours(sessionId: string): Promise<Tour[]> {
  return apiFetch(`/api/tours?session=${encodeURIComponent(sessionId)}`);
}
