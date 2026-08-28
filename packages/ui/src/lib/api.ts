import type {
  Comment,
  CommentAuthor,
  CommentKind,
  CommentSide,
  CommentThread,
  DiffFileResponse,
  DiffFingerprint,
  DiffResponse,
  FileContentResponse,
  GitHubDetails,
  PullCommentsResult,
  RepoInfoResponse,
  ReviewResult,
  ReviewSession,
  ReviewSubmission,
  Tour,
  TreeEntriesResponse,
  TreeFingerprintResponse,
  TreePathsResponse,
} from '@diffity/api';
import type { DiffFile } from '@diffity/parser';

export type {
  DiffResponse,
  GitHubDetails,
  GitHubRemote,
  PrComment,
  PrReview,
  RepoInfoResponse,
  ReviewEvent,
  ReviewResult,
  ReviewRun,
  Suppressed,
  Tour,
  TourStep,
  TreeEntry,
} from '@diffity/api';

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return res.json();
}

async function apiVoid(url: string, init?: RequestInit): Promise<void> {
  const res = await fetch(url, init);
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

export function fetchDiff(hideWhitespace: boolean, ref?: string): Promise<DiffResponse> {
  return apiFetch(buildUrl('/api/diff', {
    whitespace: hideWhitespace ? 'hide' : undefined,
    ref,
  }));
}

export async function fetchDiffFile(
  path: string,
  hideWhitespace: boolean,
  ref?: string,
): Promise<DiffFile | null> {
  const json = await apiFetch<DiffFileResponse>(
    buildUrl('/api/diff/file', { path, ref, whitespace: hideWhitespace ? 'hide' : undefined }),
  );
  return json.file;
}

export async function fetchDiffFingerprint(ref?: string): Promise<DiffFingerprint> {
  const json = await apiFetch<DiffFingerprint>(buildUrl('/api/diff-fingerprint', { ref }));
  return { fingerprint: json.fingerprint, files: json.files ?? {} };
}

export function fetchRepoInfo(ref?: string): Promise<RepoInfoResponse> {
  return apiFetch(buildUrl('/api/info', { ref }));
}

export function openInEditor(filePath: string, line?: number): Promise<{ ok: boolean }> {
  return apiFetch('/api/open-in-editor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath, line }),
  });
}



export async function fetchSession(): Promise<ReviewSession | null> {
  const res = await fetch('/api/sessions/current');
  if (!res.ok) {
    return null;
  }
  return res.json();
}

export async function fetchThreads(sessionId: string, status?: string): Promise<CommentThread[]> {
  const res = await fetch(buildUrl('/api/threads', { session: sessionId, status }));
  if (!res.ok) {
    return [];
  }
  return res.json();
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function createThread(data: {
  sessionId: string;
  filePath: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
  body: string;
  author: CommentAuthor;
  anchorContent?: string;
  /** An aside starts a conversation rather than a finding, and is never posted. */
  kind?: CommentKind;
  live?: boolean;
  intent?: 'ask' | 'act';
}): Promise<CommentThread> {
  return apiFetch('/api/threads', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });
}

export interface ReplyOptions {
  /** An aside stays on this machine. Only an aside can ask the agent for anything. */
  aside?: boolean;
  /** Ask the agent to answer, amend or act on it. */
  live?: boolean;
  /** A question, or a request for a change. Absent is a question. */
  intent?: 'ask' | 'act';
}

export function replyToThread(
  threadId: string,
  body: string,
  author: CommentAuthor,
  options: ReplyOptions = {},
): Promise<Comment> {
  return apiFetch(`/api/threads/${threadId}/reply`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      body,
      author,
      kind: options.aside ? 'aside' : 'review',
      live: options.live === true,
      intent: options.intent ?? 'ask',
    }),
  });
}

export function updateThreadStatus(threadId: string, status: string, summary?: string): Promise<void> {
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

export function revertFile(filePath: string, isUntracked: boolean): Promise<void> {
  return apiVoid('/api/revert-file', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ filePath, isUntracked }),
  });
}

export function revertHunk(patch: string): Promise<void> {
  return apiVoid('/api/revert-hunk', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ patch }),
  });
}

export async function fetchFileContent(filePath: string, ref?: string): Promise<string[]> {
  const json = await apiFetch<FileContentResponse>(
    buildUrl(`/api/file/${encodeURIComponent(filePath)}`, { ref }),
  );
  return json.content;
}

export async function fetchGitHubDetails(): Promise<GitHubDetails | null> {
  const res = await fetch('/api/github/details');
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

export function fetchTour(tourId: string): Promise<Tour> {
  return apiFetch(`/api/tours/${tourId}`);
}

export function fetchTours(sessionId: string): Promise<Tour[]> {
  return apiFetch(`/api/tours?session=${encodeURIComponent(sessionId)}`);
}

export function fetchTreePaths(): Promise<TreePathsResponse> {
  return apiFetch('/api/tree');
}

export function fetchTreeEntries(dirPath?: string): Promise<TreeEntriesResponse> {
  return apiFetch(buildUrl('/api/tree/entries', { path: dirPath }));
}

export function fetchTreeInfo(): Promise<RepoInfoResponse> {
  return apiFetch('/api/tree/info');
}

export async function fetchTreeFingerprint(): Promise<string> {
  const json = await apiFetch<TreeFingerprintResponse>('/api/tree/fingerprint');
  return json.fingerprint;
}

export async function fetchTreeFileContent(filePath: string): Promise<string[]> {
  const json = await apiFetch<FileContentResponse>(
    `/api/tree/file/${encodeURIComponent(filePath)}`,
  );
  return json.content;
}
