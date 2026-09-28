import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GENERAL_THREAD_FILE_PATH, THREAD_STATUSES, type CommentAuthor, type CommentThread } from '@diffity/api';
import { AmbiguousIdError, type ReviewSessionRecord } from './reviews.js';
import { ServiceError, describeSession, type ReviewService } from './service.js';
import { clampToFile, readAnchor, splitLines } from './anchor.js';
import { MAX_WAIT_SECONDS, awaitCommand, type Live } from './live.js';

export interface McpContext {
  service: ReviewService;
  live: Live;
  userId: string;
  /** Who the comments are from, as the connecting client named itself when it registered. */
  agentName: string;
  version: string;
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] };
}

function failure(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Every tool answers a mistake as a result the model can read, never as a protocol error. */
function guarded<A>(work: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async args => {
    try {
      return await work(args);
    } catch (err) {
      if (err instanceof ServiceError || err instanceof AmbiguousIdError) {
        return failure(err.message);
      }
      return failure(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

let reviewMethod: string | undefined;

/** Beside the module: the build copies it into dist. */
function reviewPromptText(repo: string, pr?: string): string {
  reviewMethod ??= readFileSync(new URL('./review-prompt.md', import.meta.url), 'utf-8');
  const number = pr?.trim().replace(/^#/, '');
  const target = number
    ? `Review pull request #${number} of ${repo}: \`create_session { repo: "${repo}", pr: ${number} }\`.`
    : `Review a change in ${repo}.`;
  return `${target}\n\n${reviewMethod}`;
}

function reviewPrompt(input: { repo: string; pr?: string }): GetPromptResult {
  return {
    description: 'Review a change on this diffity server',
    messages: [{ role: 'user', content: { type: 'text', text: reviewPromptText(input.repo, input.pr) } }],
  };
}

const sessionArg = z.string().min(1).describe('Session id (full or its first 8 characters)');
const line = z.number().int().min(1);
const body = z.string().min(1);

function summariseThread(thread: CommentThread) {
  return {
    id: thread.id,
    status: thread.status,
    file: thread.filePath === GENERAL_THREAD_FILE_PATH ? null : thread.filePath,
    side: thread.side,
    startLine: thread.startLine,
    endLine: thread.endLine,
    comments: thread.comments.map(comment => ({
      id: comment.id,
      author: comment.author,
      kind: comment.kind,
      body: comment.body,
      createdAt: comment.createdAt,
    })),
  };
}

export function createMcpServer(ctx: McpContext): McpServer {
  const { service, userId } = ctx;
  const reviews = service.reviews;
  const agent: CommentAuthor = { name: ctx.agentName, type: 'agent' };
  const server = new McpServer({ name: 'diffity', version: ctx.version });

  const session = (id: string): Promise<ReviewSessionRecord> => service.requireSession(userId, id);

  const thread = async (id: string, sessionId?: string): Promise<CommentThread> => {
    const found = await reviews.getThread(userId, id);
    if (!found) {
      throw new ServiceError(`No thread matches ${id}`);
    }
    if (sessionId !== undefined && found.sessionId !== (await session(sessionId)).id) {
      throw new ServiceError(`Thread ${id} belongs to another session`);
    }
    return found;
  };

  const tour = async (id: string) => {
    const found = await reviews.getTour(userId, id);
    if (!found) {
      throw new ServiceError(`No walkthrough matches ${id}`);
    }
    return found;
  };

  const describe = (record: ReviewSessionRecord) => ({
    session: record.id,
    url: service.sessionUrl(record.id),
    repo: `${record.owner}/${record.repo}`,
    kind: record.kind,
    pr: record.prNumber,
    title: record.prMeta?.title ?? null,
    description: describeSession(record),
    base: record.baseSha,
    head: record.headSha,
    createdAt: record.createdAt,
  });

  server.registerTool(
    'create_session',
    {
      description:
        'Open a review session on pushed code. Give the repository and exactly one of: `pr` (a pull request number); '
        + '`base` and `head` (full commit shas); or `base` and `patch` (a unified diff applied to base, for work that is not pushed). '
        + 'Returns the session id, the URL the user opens to read the review, and the changed files. '
        + 'The `review` prompt of this server holds the method for reviewing through these tools.',
      inputSchema: {
        repo: z.string().describe('"owner/name" on GitHub'),
        pr: z.number().int().positive().optional(),
        base: z.string().optional().describe('Full 40-character commit sha'),
        head: z.string().optional().describe('Full 40-character commit sha'),
        patch: z.string().optional().describe('Unified diff (git diff output) against base'),
      },
    },
    guarded(async args => {
      const created = await service.createSession(userId, args);
      return json({
        ...describe(created.session),
        created: created.created,
        carriedThreads: created.carried,
        files: created.files.map(file => ({
          status: file.status,
          path: file.newPath,
          ...(file.oldPath !== file.newPath ? { oldPath: file.oldPath } : {}),
        })),
      });
    }),
  );

  server.registerTool(
    'list_sessions',
    {
      description: 'List your review sessions, newest first.',
      inputSchema: { repo: z.string().optional().describe('Only sessions of this "owner/name"') },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ repo }) => {
      const [owner, name] = repo?.split('/') ?? [];
      return json((await reviews.listSessions(userId, { owner, repo: name })).map(describe));
    }),
  );

  server.registerTool(
    'get_diff',
    {
      description: "The session's unified diff; line numbers are in the @@ hunk headers.",
      inputSchema: { session: sessionArg, file: z.string().optional().describe('Only this file') },
      annotations: { readOnlyHint: true },
    },
    guarded(async args => {
      const raw = await service.diffText(await session(args.session), { path: args.file });
      return text(raw.trim() ? raw : 'No changes.');
    }),
  );

  server.registerTool(
    'get_file',
    {
      description: 'A file as it is on one side of the diff: `new` is the head, `old` the base.',
      inputSchema: { session: sessionArg, path: z.string().min(1), side: z.enum(['old', 'new']).default('new') },
      annotations: { readOnlyHint: true },
    },
    guarded(async args => {
      const content = await service.readFile(await session(args.session), args.side, args.path);
      if (content === null) {
        throw new ServiceError(`${args.path} does not exist on the ${args.side} side`);
      }
      return text(content);
    }),
  );

  server.registerTool(
    'get_standards',
    {
      description: "The project's review standards and severity labels, from .diffity.json at the head.",
      inputSchema: { session: sessionArg },
      annotations: { readOnlyHint: true },
    },
    guarded(async args => json(await service.standards(await session(args.session)))),
  );

  server.registerTool(
    'review_start',
    {
      description: 'Say a review is under way, so the page shows it is not finished. Call review_done at the end, always.',
      inputSchema: { session: sessionArg, note: z.string().optional() },
    },
    guarded(async args => {
      await reviews.startReview(userId, (await session(args.session)).id, args.note ?? '');
      return text('Review marked as in progress');
    }),
  );

  server.registerTool(
    'review_done',
    {
      description: 'Say the review is finished, including when nothing was found.',
      inputSchema: { session: sessionArg },
    },
    guarded(async args => {
      await reviews.finishReview(userId, (await session(args.session)).id);
      return text('Review marked as finished');
    }),
  );

  server.registerTool(
    'comment',
    {
      description:
        'Leave an inline finding on a file in the diff. `side` is `new` (default) for added or kept lines, `old` for removed ones.',
      inputSchema: {
        session: sessionArg,
        file: z.string().min(1),
        line,
        endLine: line.optional(),
        side: z.enum(['old', 'new']).default('new'),
        body,
      },
    },
    guarded(async args => {
      if (args.endLine !== undefined && args.endLine < args.line) {
        throw new ServiceError('endLine must not be before line');
      }
      const record = await session(args.session);
      await service.assertInDiff(record, args.file, args.side);
      const content = await service.readFile(record, args.side, args.file);
      const requestedEnd = args.endLine ?? args.line;
      const { startLine, endLine } = clampToFile(
        content === null ? null : splitLines(content).length,
        args.line,
        requestedEnd,
      );
      const created = await reviews.createThread({
        userId,
        sessionId: record.id,
        filePath: args.file,
        side: args.side,
        startLine,
        endLine,
        body: args.body,
        author: agent,
        // Recorded so the finding can follow its code when the pull request moves on.
        anchorContent: args.side === 'new' && content !== null ? readAnchor(content, startLine, endLine) : null,
      });
      return json({
        thread: created.id,
        startLine,
        endLine,
        ...(startLine !== args.line || endLine !== requestedEnd
          ? { warning: `${args.file} has fewer lines than ${args.line}-${requestedEnd}; anchored to ${startLine}-${endLine}` }
          : {}),
      });
    }),
  );

  server.registerTool(
    'general_comment',
    {
      description: 'A comment on the whole diff rather than on any line: the review summary.',
      inputSchema: { session: sessionArg, body },
    },
    guarded(async args => {
      const created = await reviews.createThread({
        userId,
        sessionId: (await session(args.session)).id,
        filePath: GENERAL_THREAD_FILE_PATH,
        side: 'new',
        startLine: 0,
        endLine: 0,
        body: args.body,
        author: agent,
      });
      return json({ thread: created.id });
    }),
  );

  server.registerTool(
    'reply',
    {
      description: 'Reply in a thread. An aside is a note for the reader that is never posted to the forge.',
      inputSchema: {
        id: z.string().min(1).describe('Thread id (full or first 8 characters)'),
        body,
        session: sessionArg.optional(),
        aside: z.boolean().optional(),
      },
    },
    guarded(async args => {
      const found = await thread(args.id, args.session);
      const reply = await reviews.addReply(userId, found.id, args.body, agent, args.aside ? 'aside' : 'review');
      await ctx.live.answer(userId, found.id);
      return json({ thread: found.id, comment: reply.id });
    }),
  );

  server.registerTool(
    'amend',
    {
      description: "Rewrite a comment's body. Takes a comment id, or a thread id to rewrite the finding that opens it.",
      inputSchema: { id: z.string().min(1), body, session: sessionArg.optional() },
    },
    guarded(async args => {
      const scoped = args.session === undefined ? undefined : (await session(args.session)).id;
      const comment = await reviews.findComment(userId, args.id);
      let commentId: string;
      let sessionId: string;
      if (comment) {
        commentId = comment.comment.id;
        sessionId = comment.sessionId;
      } else {
        const found = await reviews.getThread(userId, args.id);
        if (!found || found.comments.length === 0) {
          throw new ServiceError(`No comment or thread matches ${args.id}`);
        }
        commentId = found.comments[0].id;
        sessionId = found.sessionId;
      }
      if (scoped !== undefined && sessionId !== scoped) {
        throw new ServiceError(`${args.id} belongs to another session`);
      }
      await reviews.editComment(userId, commentId, args.body);
      return json({ comment: commentId });
    }),
  );

  server.registerTool(
    'resolve',
    {
      description: 'Mark a thread as fixed, optionally saying what was done.',
      inputSchema: { id: z.string().min(1), summary: z.string().optional(), session: sessionArg.optional() },
    },
    guarded(async args => {
      const found = await thread(args.id, args.session);
      await reviews.updateThreadStatus(userId, found.id, 'resolved', args.summary, args.summary ? agent : undefined);
      return text(`Resolved thread ${found.id.slice(0, 8)}`);
    }),
  );

  server.registerTool(
    'dismiss',
    {
      description: "Mark a thread as won't fix, optionally saying why.",
      inputSchema: { id: z.string().min(1), reason: z.string().optional(), session: sessionArg.optional() },
    },
    guarded(async args => {
      const found = await thread(args.id, args.session);
      await reviews.updateThreadStatus(userId, found.id, 'dismissed', args.reason, args.reason ? agent : undefined);
      return text(`Dismissed thread ${found.id.slice(0, 8)}`);
    }),
  );

  server.registerTool(
    'list_comments',
    {
      description: "The session's threads with their comments.",
      inputSchema: { session: sessionArg, status: z.enum(THREAD_STATUSES).optional() },
      annotations: { readOnlyHint: true },
    },
    guarded(async args =>
      json((await reviews.threadsForSession(userId, (await session(args.session)).id, args.status)).map(summariseThread)),
    ),
  );

  server.registerTool(
    'tour_start',
    {
      description: 'Start a walkthrough, such as the reading order of a review. Add steps with tour_step, then tour_done.',
      inputSchema: { session: sessionArg, topic: z.string().min(1), body: z.string().optional() },
    },
    guarded(async args => {
      const created = await reviews.createTour(userId, (await session(args.session)).id, args.topic, args.body ?? '');
      return json({ tour: created.id });
    }),
  );

  server.registerTool(
    'tour_step',
    {
      description:
        'Add a step to a walkthrough. `annotation` becomes the file\'s label in the reordered file list: say why it is read here.',
      inputSchema: {
        tour: z.string().min(1),
        file: z.string().min(1),
        line,
        endLine: line.optional(),
        body,
        annotation: z.string().optional(),
      },
    },
    guarded(async args => {
      if (args.endLine !== undefined && args.endLine < args.line) {
        throw new ServiceError('endLine must not be before line');
      }
      const found = await tour(args.tour);
      const record = await session(found.sessionId);
      if ((await service.readFile(record, 'new', args.file)) === null) {
        throw new ServiceError(`${args.file} does not exist at the session's head`);
      }
      const step = await reviews.addTourStep(userId, found.id, {
        filePath: args.file,
        startLine: args.line,
        endLine: args.endLine ?? args.line,
        body: args.body,
        annotation: args.annotation ?? '',
      });
      return json({ tour: found.id, step: step.sortOrder });
    }),
  );

  server.registerTool(
    'tour_done',
    {
      description: 'Mark a walkthrough as ready to read.',
      inputSchema: { tour: z.string().min(1) },
    },
    guarded(async args => {
      const found = await tour(args.tour);
      await reviews.updateTourStatus(userId, found.id, 'ready');
      return text('Walkthrough marked as ready');
    }),
  );

  server.registerTool(
    'tour_delete',
    {
      description: 'Remove a walkthrough, to rebuild one that went in wrong.',
      inputSchema: { tour: z.string().min(1) },
    },
    guarded(async args => {
      const found = await tour(args.tour);
      await reviews.deleteTour(userId, found.id);
      return text(`Removed walkthrough ${found.id.slice(0, 8)}`);
    }),
  );

  server.registerTool(
    'live_token',
    {
      description:
        'Wait for the reader\'s questions on a session. Returns a shell command to run in the background: it exits when '
        + 'the reader asks something, printing the question and its thread. Answer with `reply`, then run the command again. '
        + 'The token only waits on this session and expires after 12 hours; the command exits non-zero once it is refused.',
      inputSchema: { session: sessionArg },
    },
    guarded(async args => {
      const record = await session(args.session);
      const { token, expiresAt } = await ctx.live.issueToken(userId, record.id);
      const pollUrl = new URL(`/live/await?session=${record.id}&wait=${MAX_WAIT_SECONDS}`, service.publicUrl).href;
      return json({
        session: record.id,
        token,
        expiresAt: new Date(expiresAt).toISOString(),
        pollUrl,
        command: awaitCommand(token, pollUrl),
        run: 'Run `command` as a background command (Claude Code: Bash with run_in_background). When it exits 0 its output '
          + 'is the question; answer it with `reply`, then run the same command again. Exit 1 means the token is no longer valid.',
      });
    }),
  );

  server.registerPrompt(
    'review',
    {
      title: 'Review a change',
      description: 'How to review a pull request, commit range or patch through these tools, ending with the review URL for the user.',
      argsSchema: {
        repo: z.string().describe('"owner/name" on GitHub'),
        pr: z.string().optional().describe('Pull request number'),
      },
    },
    args => reviewPrompt(args),
  );

  return server;
}
