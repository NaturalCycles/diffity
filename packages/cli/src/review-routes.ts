import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isThreadStatus,
  parseCreateThreadRequest,
  parseDeleteThreadsRequest,
  parseEditCommentRequest,
  parseReplyRequest,
  parseUpdateThreadStatusRequest,
  THREAD_STATUSES,
  type Comment,
} from '@diffity/api';
import {
  createThread,
  getThreadsForSession,
  addReply,
  updateThreadStatus,
  deleteThread,
  deleteAllThreadsForSession,
  editComment,
  deleteComment,
} from './threads.js';
import { requestLive, notifyLiveListeners } from './live.js';
import { resolveSessionId } from './session.js';
import { sendJson, sendError, withJsonBody } from './http-utils.js';

export function handleReviewRoute(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): boolean {
  if (pathname === '/api/threads' && req.method === 'GET') {
    const sid = resolveSessionId(url.searchParams.get('session'));
    if (!sid) {
      sendError(res, 400, 'No review session');
      return true;
    }
    const status = url.searchParams.get('status') || undefined;
    if (status !== undefined && !isThreadStatus(status)) {
      sendError(res, 400, `status must be one of: ${THREAD_STATUSES.join(', ')}`);
      return true;
    }
    const threads = getThreadsForSession(sid, status);
    sendJson(res, threads);
    return true;
  }

  if (pathname === '/api/threads' && req.method === 'DELETE') {
    withJsonBody(res, req, 'Failed to delete all threads', parseDeleteThreadsRequest, (body) => {
      deleteAllThreadsForSession(body.sessionId);
      sendJson(res, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/threads' && req.method === 'POST') {
    withJsonBody(res, req, 'Failed to create thread', parseCreateThreadRequest, (body) => {
      const kind = body.kind ?? 'review';
      const thread = createThread(
        body.sessionId, body.filePath, body.side, body.startLine, body.endLine,
        body.body, body.author, body.anchorContent, kind,
      );
      if (body.live === true && kind === 'aside') {
        const stamp = requestLive(thread.comments[0].id, body.intent ?? 'ask');
        thread.comments[0].liveRequestedAt = stamp.requestedAt;
        notifyLiveListeners(stamp.sessionId);
      }
      sendJson(res, thread);
    });
    return true;
  }

  const threadReplyMatch = pathname.match(/^\/api\/threads\/([^/]+)\/reply$/);
  if (threadReplyMatch && req.method === 'POST') {
    withJsonBody(res, req, 'Failed to add reply', parseReplyRequest, (body) => {
      const kind = body.kind ?? 'review';
      const comment = addReply(threadReplyMatch[1], body.body, body.author, kind);
      // Only an aside can ask the agent for something: a review comment is addressed to the pull
      // request's author, and it is going to the forge rather than to a listener here.
      let requestedAt: string | null = null;
      if (body.live === true && kind === 'aside') {
        const stamp = requestLive(comment.id, body.intent ?? 'ask');
        requestedAt = stamp.requestedAt;
        notifyLiveListeners(stamp.sessionId);
      }
      sendJson(res, { ...comment, liveRequestedAt: requestedAt } satisfies Comment);
    });
    return true;
  }

  const threadStatusMatch = pathname.match(/^\/api\/threads\/([^/]+)\/status$/);
  if (threadStatusMatch && req.method === 'PATCH') {
    withJsonBody(res, req, 'Failed to update thread status', parseUpdateThreadStatusRequest, (body) => {
      const summaryAuthor = body.summary ? { name: 'System', type: 'user' as const } : undefined;
      updateThreadStatus(threadStatusMatch[1], body.status, body.summary, summaryAuthor);
      sendJson(res, { ok: true });
    });
    return true;
  }

  const threadDeleteMatch = pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (threadDeleteMatch && req.method === 'DELETE') {
    try {
      deleteThread(threadDeleteMatch[1]);
      sendJson(res, { ok: true });
    } catch (err) {
      sendError(res, 500, `Failed to delete thread: ${err}`);
    }
    return true;
  }

  const commentEditMatch = pathname.match(/^\/api\/comments\/([^/]+)$/);
  if (commentEditMatch && req.method === 'PATCH') {
    withJsonBody(res, req, 'Failed to edit comment', parseEditCommentRequest, (body) => {
      editComment(commentEditMatch[1], body.body);
      sendJson(res, { ok: true });
    });
    return true;
  }

  const commentDeleteMatch = pathname.match(/^\/api\/comments\/([^/]+)$/);
  if (commentDeleteMatch && req.method === 'DELETE') {
    try {
      deleteComment(commentDeleteMatch[1]);
      sendJson(res, { ok: true });
    } catch (err) {
      sendError(res, 500, `Failed to delete comment: ${err}`);
    }
    return true;
  }

  return false;
}
