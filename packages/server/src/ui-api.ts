import { createHash } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import {
  isThreadStatus,
  parseCreateThreadRequest,
  parseDeleteThreadsRequest,
  parseEditCommentRequest,
  parsePullCommentsRequest,
  parseReplyRequest,
  parseReviewSubmission,
  parseUpdateThreadStatusRequest,
  THREAD_STATUSES,
  type CommentAuthor,
  type DiffFileResponse,
  type DiffFingerprint,
  type FileContentResponse,
  type ParseResult,
  type RepoInfoResponse,
} from '@diffity/api';
import type { ReviewSessionRecord } from './reviews.js';
import { describeSession, ServiceError, type ReviewService } from './service.js';
import { splitLines } from './anchor.js';
import type { User } from './users.js';

export interface UiApiDeps {
  service: ReviewService;
  userFor: (req: Request) => Promise<User | null>;
}

interface Scoped {
  user: User;
  session: ReviewSessionRecord;
}

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

function parsed<T>(res: Response, result: ParseResult<T>): T | null {
  if (!result.ok) {
    fail(res, 400, result.error);
    return null;
  }
  return result.value;
}

/** The `/api/*` subset the review UI needs, scoped to one session of the signed-in user. */
export function uiApiRouter(deps: UiApiDeps): Router {
  const { service } = deps;
  const reviews = service.reviews;
  const router = express.Router({ mergeParams: true });
  router.use(express.json({ limit: '2mb' }));

  const scope = async (req: Request, res: Response): Promise<Scoped | null> => {
    const user = await deps.userFor(req);
    if (!user) {
      fail(res, 401, 'Sign in first');
      return null;
    }
    const session = await reviews.getSession(user.id, String(req.params.sid));
    // Somebody else's session answers exactly like one that does not exist.
    if (!session || session.id !== req.params.sid) {
      fail(res, 404, 'Session not found');
      return null;
    }
    return { user, session };
  };

  const handle = (work: (scoped: Scoped, req: Request, res: Response) => Promise<void> | void) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        const scoped = await scope(req, res);
        if (scoped) {
          await work(scoped, req, res);
        }
      } catch (err) {
        if (!res.headersSent) {
          fail(res, err instanceof ServiceError ? err.status : 500, err instanceof Error ? err.message : String(err));
        }
      }
    };

  const author = (user: User): CommentAuthor => ({ name: user.name, type: 'user' });

  const sessionMatches = (res: Response, session: ReviewSessionRecord, asked: unknown): boolean => {
    if (asked !== undefined && asked !== null && asked !== '' && asked !== session.id) {
      fail(res, 400, 'session does not match this review');
      return false;
    }
    return true;
  };

  const threadInSession = async (res: Response, { user, session }: Scoped, threadId: string) => {
    const thread = await reviews.getThread(user.id, threadId);
    if (!thread || thread.sessionId !== session.id) {
      fail(res, 404, 'Thread not found');
      return null;
    }
    return thread;
  };

  const commentInSession = async (res: Response, { user, session }: Scoped, commentId: string) => {
    const comment = await reviews.findComment(user.id, commentId);
    if (!comment || comment.sessionId !== session.id) {
      fail(res, 404, 'Comment not found');
      return null;
    }
    return comment;
  };

  router.get('/info', handle(({ session }, _req, res) => {
    res.json({
      name: `${session.owner}/${session.repo}`,
      branch: session.prMeta?.headRef ?? session.headSha.slice(0, 7),
      root: `github.com/${session.owner}/${session.repo}`,
      description: describeSession(session),
      sessionId: session.id,
      review: session.review,
      github: session.prNumber !== null ? { owner: session.owner, repo: session.repo } : null,
    } satisfies RepoInfoResponse);
  }));

  router.get('/diff', handle(async ({ session }, req, res) => {
    res.json(await service.parsedDiff(session, { ignoreWhitespace: req.query.whitespace === 'hide' }));
  }));

  router.get('/diff/file', handle(async ({ session }, req, res) => {
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    if (!path) {
      fail(res, 400, 'Missing path');
      return;
    }
    const diff = await service.parsedDiff(session, { ignoreWhitespace: req.query.whitespace === 'hide', path });
    res.json({ file: diff.files[0] ?? null } satisfies DiffFileResponse);
  }));

  // Both ends are fixed commits, so the diff can never go stale; the fingerprint says so.
  router.get('/diff-fingerprint', handle(({ session }, _req, res) => {
    res.json({
      fingerprint: createHash('sha1').update(`${session.baseSha}..${session.headSha}`).digest('hex'),
      files: {},
    } satisfies DiffFingerprint);
  }));

  const serveFile = (side: 'old' | 'new') => handle(async ({ session }, req, res) => {
    const raw = (req.params as { path?: string | string[] }).path;
    const decoded = Array.isArray(raw) ? raw.join('/') : raw ?? '';
    const chosen = side === 'old' && req.query.side === 'new' ? 'new' : side;
    const content = await service.readFile(session, chosen, decoded);
    if (content === null) {
      fail(res, 404, `File not found: ${decoded}`);
      return;
    }
    res.json({ path: decoded, content: splitLines(content) } satisfies FileContentResponse);
  });

  // The UI asks for the base side here, the way the CLI answers it for a ref.
  router.get('/file/{*path}', serveFile('old'));
  // The rich markdown and SVG preview reads the new side through the tree route.
  router.get('/tree/file/{*path}', serveFile('new'));

  router.get('/threads', handle(async ({ user, session }, req, res) => {
    if (!sessionMatches(res, session, req.query.session)) {
      return;
    }
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    if (status !== undefined && !isThreadStatus(status)) {
      fail(res, 400, `status must be one of: ${THREAD_STATUSES.join(', ')}`);
      return;
    }
    res.json(await reviews.threadsForSession(user.id, session.id, status));
  }));

  router.post('/threads', handle(async ({ user, session }, req, res) => {
    const body = parsed(res, parseCreateThreadRequest(req.body));
    if (!body || !sessionMatches(res, session, body.sessionId)) {
      return;
    }
    res.json(await reviews.createThread({
      userId: user.id,
      sessionId: session.id,
      filePath: body.filePath,
      side: body.side,
      startLine: body.startLine,
      endLine: body.endLine,
      body: body.body,
      author: author(user),
      anchorContent: body.anchorContent,
      kind: body.kind ?? 'review',
    }));
  }));

  router.delete('/threads', handle(async ({ user, session }, req, res) => {
    const body = parsed(res, parseDeleteThreadsRequest(req.body));
    if (!body || !sessionMatches(res, session, body.sessionId)) {
      return;
    }
    await reviews.deleteThreadsForSession(user.id, session.id);
    res.json({ ok: true });
  }));

  router.post('/threads/:id/reply', handle(async (scoped, req, res) => {
    const thread = await threadInSession(res, scoped, String(req.params.id));
    const body = thread && parsed(res, parseReplyRequest(req.body));
    if (!thread || !body) {
      return;
    }
    res.json(await reviews.addReply(scoped.user.id, thread.id, body.body, author(scoped.user), body.kind ?? 'review'));
  }));

  router.patch('/threads/:id/status', handle(async (scoped, req, res) => {
    const thread = await threadInSession(res, scoped, String(req.params.id));
    const body = thread && parsed(res, parseUpdateThreadStatusRequest(req.body));
    if (!thread || !body) {
      return;
    }
    await reviews.updateThreadStatus(
      scoped.user.id,
      thread.id,
      body.status,
      body.summary,
      body.summary ? { name: 'System', type: 'user' } : undefined,
    );
    res.json({ ok: true });
  }));

  router.delete('/threads/:id', handle(async (scoped, req, res) => {
    const thread = await threadInSession(res, scoped, String(req.params.id));
    if (!thread) {
      return;
    }
    await reviews.deleteThread(scoped.user.id, thread.id);
    res.json({ ok: true });
  }));

  router.patch('/comments/:id', handle(async (scoped, req, res) => {
    const comment = await commentInSession(res, scoped, String(req.params.id));
    const body = comment && parsed(res, parseEditCommentRequest(req.body));
    if (!comment || !body) {
      return;
    }
    await reviews.editComment(scoped.user.id, comment.comment.id, body.body);
    res.json({ ok: true });
  }));

  router.delete('/comments/:id', handle(async (scoped, req, res) => {
    const comment = await commentInSession(res, scoped, String(req.params.id));
    if (!comment) {
      return;
    }
    await reviews.deleteComment(scoped.user.id, comment.comment.id);
    res.json({ ok: true });
  }));

  router.get('/tours', handle(async ({ user, session }, req, res) => {
    if (!sessionMatches(res, session, req.query.session)) {
      return;
    }
    res.json(await reviews.toursForSession(user.id, session.id));
  }));

  router.get('/tours/:id', handle(async ({ user, session }, req, res) => {
    const tour = await reviews.getTour(user.id, String(req.params.id));
    if (!tour || tour.sessionId !== session.id) {
      fail(res, 404, 'Tour not found');
      return;
    }
    res.json(tour);
  }));

  router.get('/github/details', handle(async ({ session }, _req, res) => {
    res.json(await service.gitHubDetails(session));
  }));

  router.post('/github/create-review', handle(async ({ session }, req, res) => {
    const body = parsed(res, parseReviewSubmission(req.body));
    if (body) {
      res.json(await service.postReview(session, body));
    }
  }));

  router.post('/github/pull-comments', handle(async ({ session }, req, res) => {
    const body = parsed(res, parsePullCommentsRequest(req.body));
    if (body && sessionMatches(res, session, body.sessionId)) {
      res.json(await service.pullComments(session));
    }
  }));

  router.use((_req: Request, res: Response) => fail(res, 404, 'Not found'));
  return router;
}
