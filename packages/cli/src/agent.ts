import { existsSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { Command } from 'commander';
import pc from 'picocolors';
import { isGitRepo, getDiffFiles, resolveRef, getRepoRoot } from '@diffity/git';
import {
  createThread,
  getThreadsForSession,
  getThread,
  addReply,
  updateThreadStatus,
  editComment,
  type Thread,
} from './threads.js';
import {
  GENERAL_THREAD_FILE_PATH,
  isThreadStatus,
  THREAD_STATUSES,
  type ClaimResponse,
  type GitHubDetails,
  type LiveStatusResponse,
} from '@diffity/api';
import { answerLiveRequest } from './live.js';
import { clampClientWait, CLIENT_WAIT_CAP_SECONDS } from './live-wait.js';
import { directiveFor } from './live-intent.js';
import { AGENT_HEADER, SERVER_TIMEOUT_MS, findRunningInstance, resolveAgentSession } from './agent-session.js';
import type { Session } from './session.js';
import { createTour, addTourStep, updateTourStatus, deleteTour, deleteToursForSession, getTour } from './tours.js';
import { unansweredRequest } from './live-unanswered.js';
import { describeSince } from './live-events.js';
import { readAnchor, clampToFile, countWorkingTreeLines } from './anchor.js';
import { unescapeMarkdown as fromShell } from './unescape.js';
import { startReviewRun, finishReviewRun } from './review-run.js';
import { readRepoConfig, DEFAULT_SEVERITIES, resolveInRepo, REPO_CONFIG_FILE } from '@diffity/git';
import { readFileSync } from 'node:fs';

async function requireSession(explicitId?: string): Promise<Session> {
  if (!isGitRepo()) {
    console.error(pc.red('Error: Not a git repository'));
    process.exit(1);
  }

  const session = await resolveAgentSession(explicitId);
  if (!session) {
    if (explicitId) {
      console.error(pc.red(`Error: No session matches ${explicitId}`));
      process.exit(1);
    }
    console.error(pc.red('Error: No active review session.'));
    console.error(pc.dim('Start diffity first to create a session.'));
    process.exit(1);
  }
  return session;
}

function assertFileExists(filePath: string): void {
  if (isAbsolute(filePath)) {
    console.error(pc.red(`Error: --file must be relative to the repo root, got absolute path: ${filePath}`));
    process.exit(1);
  }
  const abs = join(getRepoRoot(), filePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    console.error(pc.red(`Error: File not found at repo root: ${filePath}`));
    console.error(pc.dim(`  Checked: ${abs}`));
    if (filePath.includes('..')) {
      console.error(pc.dim(`  Tip: consecutive dots suggest a shell variable expanded to empty.`));
      console.error(pc.dim(`  If your path contains "$" (e.g. "teams.$teamId.tsx"), single-quote the --file value`));
      console.error(pc.dim(`  or escape it: --file 'apps/routes/teams.$teamId.tsx'`));
    }
    process.exit(1);
  }
}

function resolveThreadId(shortId: string, sessionId: string): Thread {
  const thread = getThread(shortId);
  if (!thread) {
    console.error(pc.red(`Error: Thread not found: ${shortId}`));
    process.exit(1);
  }
  if (thread.sessionId !== sessionId) {
    console.error(pc.red(`Error: Thread ${shortId} does not belong to current session`));
    process.exit(1);
  }
  return thread;
}

function resolveTourId(shortId: string, sessionId: string): string {
  const tour = getTour(shortId);
  if (!tour) {
    console.error(pc.red(`Error: Tour not found: ${shortId}`));
    process.exit(1);
  }
  if (tour.sessionId !== sessionId) {
    console.error(pc.red(`Error: Tour ${shortId} does not belong to current session`));
    process.exit(1);
  }
  return tour.id;
}

function formatThreadLine(thread: Thread): string {
  const shortId = thread.id.slice(0, 8);
  const isGeneral = thread.filePath === GENERAL_THREAD_FILE_PATH;
  const statusColor = thread.status === 'open' ? pc.yellow : thread.status === 'resolved' ? pc.green : thread.status === 'dismissed' ? pc.dim : pc.cyan;
  const statusLabel = statusColor(`[${thread.status}]`);
  const firstComment = thread.comments[0]?.body || '';
  const truncated = firstComment.length > 80 ? firstComment.slice(0, 77) + '...' : firstComment;

  if (isGeneral) {
    return `${statusLabel.padEnd(22)} ${pc.dim(shortId)}  ${pc.bold('General comment')}\n${''.padEnd(15)}${pc.dim('"')}${truncated}${pc.dim('"')}`;
  }

  const lineRange = thread.startLine === thread.endLine
    ? `${thread.startLine}`
    : `${thread.startLine}-${thread.endLine}`;
  const location = `${thread.filePath}:${lineRange}`;
  const sideLabel = thread.side === 'old' ? '(old)' : '(new)';

  return `${statusLabel.padEnd(22)} ${pc.dim(shortId)}  ${location} ${pc.dim(sideLabel)}\n${''.padEnd(15)}${pc.dim('"')}${truncated}${pc.dim('"')}`;
}

/** A `diffity agent await` that found nothing to do, told apart from one that failed. */
const NOTHING_ASKED_EXIT_CODE = 3;
/** Nobody has the review page open, so re-arming would wait for a question nobody can ask. */
const NOBODY_WATCHING_EXIT_CODE = 4;
interface LiveStatus {
  available: boolean;
  reason: string;
  /**
   * Reviewing is not editing. A pull request somebody else wrote may be asked about, never rewritten
   * — so this is derived from who wrote it rather than from a setting somebody can leave on.
   */
  mayChangeCode: boolean;
}

async function fetchLiveStatus(port: number): Promise<LiveStatus | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/live/status`, {
      headers: AGENT_HEADER,
      signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    const live = (await res.json()) as LiveStatusResponse;
    if (!live.enabled) {
      return { available: false, reason: 'the server is not bound to loopback', mayChangeCode: false };
    }

    const details = await fetch(`http://127.0.0.1:${port}/api/github/details`, {
      headers: AGENT_HEADER,
      signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
    });
    const pr = details.ok ? ((await details.json()) as GitHubDetails | null) : null;
    // No pull request means this is your own working tree, which is the case changes exist for.
    return { available: true, reason: '', mayChangeCode: pr ? pr.viewerDidAuthor === true : true };
  } catch {
    return null;
  }
}

/**
 * The thread a comment belongs to, if that thread has already gone to the forge. Amending then
 * leaves the pull request showing the old wording, which the reader has to be told.
 */
function findSubmittedThreadForComment(commentId: string, sessionId: string): Thread | null {
  for (const thread of getThreadsForSession(sessionId)) {
    if (thread.submittedAt && thread.comments.some(comment => comment.id === commentId)) {
      return thread;
    }
  }
  return null;
}

export function registerAgentCommands(program: Command): void {
  const agent = program
    .command('agent')
    .description('Agent commands for interacting with review comments')
    .option('--session <id>', 'Operate on this session (id or 8-char prefix) instead of the running server\'s own')
    .addHelpText('after', '\nPass --repo before `agent` when the current directory is not the repository:\n  diffity --repo <path> agent list\nPass --session between `agent` and the command to address another session:\n  diffity agent --session <id> list')
    .addHelpText('after', `
Examples:
  $ diffity agent list --status open --json
  $ diffity agent comment --file src/app.ts --line 42 --body "Missing null check"
  $ diffity agent resolve abc123 --summary "Added null check"
  $ diffity agent reply abc123 --body "Good catch, fixed"
  $ diffity agent general-comment --body "Overall this looks good, just a few nits"
  $ diffity agent tour-start --topic "How does auth work?" --body "Overview of the auth flow"
  $ diffity agent tour-step --tour <id> --file src/auth.ts --line 10 --body "Entry point"
  $ diffity agent tour-done --tour <id>`);

  agent
    .command('list')
    .description('List comment threads in the current session (use --json for full details)')
    .option('--status <status>', 'Filter by status (open, resolved, dismissed)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      if (opts.status && !isThreadStatus(opts.status)) {
        console.error(pc.red(`Error: Invalid status "${opts.status}". Must be one of: ${THREAD_STATUSES.join(', ')}`));
        process.exit(1);
      }
      const session = await requireSession(agent.opts().session);
      const threads = getThreadsForSession(session.id, opts.status);

      if (opts.json) {
        console.log(JSON.stringify(threads, null, 2));
        return;
      }

      if (threads.length === 0) {
        console.log(pc.dim('No threads found.'));
        return;
      }

      for (const thread of threads) {
        console.log(formatThreadLine(thread));
      }
    });

  agent
    .command('comment')
    .description('Create a new comment thread')
    .requiredOption('--file <path>', 'File path (relative to repo root)')
    .requiredOption('--line <n>', 'Line number (1-indexed)', parseInt)
    .option('--end-line <n>', 'End line for multi-line comments (1-indexed)', parseInt)
    .option('--side <side>', 'Which side of the diff (new or old)', 'new')
    .requiredOption('--body <text>', 'Comment body')
    .action(async (opts) => {
      if (opts.side !== 'new' && opts.side !== 'old') {
        console.error(pc.red(`Error: Invalid side "${opts.side}". Must be "new" or "old"`));
        process.exit(1);
      }
      const session = await requireSession(agent.opts().session);
      assertFileExists(opts.file);
      if (session.ref !== '__tree__') {
        const diffFiles = getDiffFiles(session.ref);
        if (!diffFiles.includes(opts.file)) {
          console.error(pc.red(`Error: File "${opts.file}" is not in the current diff.`));
          console.error(pc.dim(`The diff for ref "${session.ref}" contains ${diffFiles.length} file(s):`));
          for (const f of diffFiles.slice(0, 20)) {
            console.error(pc.dim(`  ${f}`));
          }
          if (diffFiles.length > 20) {
            console.error(pc.dim(`  ... and ${diffFiles.length - 20} more`));
          }
          process.exit(1);
        }
      }
      const requested = opts.endLine ?? opts.line;
      const { startLine, endLine } = clampToFile(
        countWorkingTreeLines(opts.file),
        opts.line,
        requested,
      );
      if (endLine !== requested || startLine !== opts.line) {
        console.error(
          pc.yellow(`Warning: ${opts.file} has fewer lines than ${opts.line}-${requested}; anchored to ${startLine}-${endLine}`),
        );
      }
      const thread = createThread(
        session.id,
        opts.file,
        opts.side,
        startLine,
        endLine,
        fromShell(opts.body),
        { name: 'Agent', type: 'agent' },
        // Recorded so the finding can follow its code when a later commit moves it.
        opts.side === 'new' ? readAnchor(opts.file, startLine, endLine) : undefined,
      );
      console.log(pc.green(`Created thread ${thread.id.slice(0, 8)}`));
    });

  agent
    .command('resolve')
    .description('Resolve a thread (marks as fixed)')
    .argument('<thread-id>', 'Thread ID (or 8-char prefix)')
    .option('--summary <text>', 'What was done to resolve it')
    .action(async (id: string, opts) => {
      const session = await requireSession(agent.opts().session);
      const thread = resolveThreadId(id, session.id);
      const author = opts.summary ? { name: 'Agent', type: 'agent' as const } : undefined;
      updateThreadStatus(thread.id, 'resolved', fromShell(opts.summary ?? ''), author);
      console.log(pc.green(`Resolved thread ${thread.id.slice(0, 8)}`));
    });

  agent
    .command('dismiss')
    .description('Dismiss a thread (marks as won\'t fix)')
    .argument('<thread-id>', 'Thread ID (or 8-char prefix)')
    .option('--reason <text>', 'Why the thread is being dismissed')
    .action(async (id: string, opts) => {
      const session = await requireSession(agent.opts().session);
      const thread = resolveThreadId(id, session.id);
      const author = opts.reason ? { name: 'Agent', type: 'agent' as const } : undefined;
      updateThreadStatus(thread.id, 'dismissed', fromShell(opts.reason ?? ''), author);
      console.log(pc.green(`Dismissed thread ${thread.id.slice(0, 8)}`));
    });

  agent
    .command('reply')
    .description('Reply to a comment thread')
    .argument('<thread-id>', 'Thread ID (or 8-char prefix)')
    .requiredOption('--body <text>', 'Reply body')
    .option('--aside', 'A note for the reader that never goes to the forge')
    .option('--answers <comment-id>', 'The request this answers, so the page stops waiting on it')
    .action(async (id: string, opts: { body: string; aside?: boolean; answers?: string }) => {
      const session = await requireSession(agent.opts().session);
      const thread = resolveThreadId(id, session.id);
      const stillOpen = unansweredRequest(thread.comments);
      addReply(thread.id, fromShell(opts.body), { name: 'Agent', type: 'agent' }, opts.aside ? 'aside' : 'review');
      if (opts.answers && !answerLiveRequest(opts.answers)) {
        console.error(
          pc.yellow(
            `No request matched ${opts.answers}, so the page still says an agent is working on it.`,
          ),
        );
      }
      if (!opts.answers && stillOpen) {
        console.error(
          pc.yellow(
            `This thread has a request nobody has closed. Replying does not close it — it will be `
            + `re-armed and handed back to you. Close it with --answers ${stillOpen.slice(0, 8)}`,
          ),
        );
      }
      console.log(pc.green(`Replied to thread ${thread.id.slice(0, 8)}`));
    });

  agent
    .command('await')
    .description('Wait for the reader to ask something, then exit so the agent can answer')
    .option('--timeout <seconds>', `How long to wait before giving up (each poll caps at ${CLIENT_WAIT_CAP_SECONDS}s and returns; call again to keep waiting)`, '900')
    .action(async (opts: { timeout: string }) => {
      const session = await requireSession(agent.opts().session);
      const instance = findRunningInstance();
      if (!instance) {
        console.error(pc.red('No diffity is running for this repository — start one first'));
        process.exitCode = 1;
        return;
      }

      const asked = Number(opts.timeout);
      const wait = clampClientWait(asked);
      if (Number.isFinite(asked) && asked > wait) {
        console.error(
          pc.dim(`Waiting ${wait}s at a time (node abandons a request after 300s without headers) — re-arm to keep going.`),
        );
      }
      const startedAt = Date.now();
      let payload: ClaimResponse;
      try {
        // Park on the session requireSession resolved — the server's own unless --session says
        // otherwise — never on whatever the shared current-session file last named.
        const claimUrl = `http://127.0.0.1:${instance.port}/api/live/claim?wait=${wait}`
          + `&session=${encodeURIComponent(session.id)}`;
        const res = await fetch(claimUrl, { method: 'POST', headers: AGENT_HEADER });
        if (!res.ok) {
          console.error(pc.red(`Could not wait for a request: ${res.status} ${await res.text()}`));
          process.exitCode = 1;
          return;
        }
        payload = (await res.json()) as ClaimResponse;
      } catch (err) {
        // `fetch failed` on its own says nothing about why a held connection went away, and a
        // listener dying early is the failure that matters most here. The cause and how long it
        // lasted are the two things worth having next time.
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        const cause = (err as { cause?: unknown }).cause;
        console.error(
          pc.red(
            `Waiting on port ${instance.port} ended after ${seconds}s of ${wait}s: ${err}`
              + (cause ? `\n  cause: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}` : ''),
          ),
        );
        process.exitCode = 1;
        return;
      }

      // Worth knowing, not worth waking for, so it is reported whatever else happened.
      const missed = payload.since ? describeSince(payload.since) : null;
      if (missed) {
        console.error(pc.yellow(missed));
      }

      if (!payload.request) {
        // `viewerGone`, not `viewerPresent`: a page that has not been opened yet also has nobody
        // watching, and stopping then would end the loop before the reader ever arrived.
        if (payload.viewerGone) {
          // Its own code so a loop can stop rather than re-arm into a closed window.
          console.log(pc.dim('The review page was closed — stopping rather than waiting again'));
          process.exitCode = NOBODY_WATCHING_EXIT_CODE;
          return;
        }
        // Its own code, so a loop can tell "nobody asked" from "something broke" and re-arm.
        console.log(pc.dim('Nothing was asked'));
        process.exitCode = NOTHING_ASKED_EXIT_CODE;
        return;
      }

      // stdout is the request, so a script can parse it. The directive goes to stderr, because the
      // turn this wakes up may be a long way from whatever armed the loop.
      console.error(
        pc.cyan(
          `${directiveFor(payload.request.intent, payload.request.mayChangeCode !== false)}\n`
            + 'Then re-arm with `agent await`. The diffity-live skill has the detail.',
        ),
      );
      console.log(JSON.stringify(payload.request, null, 2));
    });

  agent
    .command('live-status')
    .description('Whether the review page can reach an agent, and what it is allowed to ask for')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      await requireSession(agent.opts().session);
      const instance = findRunningInstance();
      const status = instance ? await fetchLiveStatus(instance.port) : null;

      if (opts.json) {
        console.log(JSON.stringify(status ?? { available: false, reason: 'no diffity is running' }));
        return;
      }

      if (!status) {
        console.log(pc.yellow('No diffity is running for this repository'));
        return;
      }
      if (!status.available) {
        console.log(pc.yellow(`Live mode is not available: ${status.reason}`));
        return;
      }
      console.log(
        pc.green(
          `Live mode is available. ${status.mayChangeCode ? 'Changes are allowed — this is your own work.' : 'Answers and amendments only — this pull request is somebody else\'s.'}`,
        ),
      );
    });

  agent
    .command('amend')
    .description("Rewrite a comment's body — the way an aside improves the finding it is about")
    .argument('<comment-id>', 'Comment to rewrite')
    .requiredOption('--body <text>', 'The new body')
    .action(async (commentId: string, opts: { body: string }) => {
      const session = await requireSession(agent.opts().session);
      const sent = findSubmittedThreadForComment(commentId, session.id);
      editComment(commentId, fromShell(opts.body));
      if (sent) {
        // The forge is showing the old wording and will keep showing it; saying so is the only
        // honest thing available, since a posted review comment cannot be edited from here.
        console.log(
          pc.yellow(
            `Amended, but this finding was already sent${sent.submittedReviewUrl ? ` — ${sent.submittedReviewUrl}` : ''}. The pull request still shows the old wording.`,
          ),
        );
        return;
      }
      console.log(pc.green('Amended'));
    });

  agent
    .command('general-comment')
    .description('Create a general comment on the entire diff (not tied to a specific file or line)')
    .requiredOption('--body <text>', 'Comment body')
    .action(async (opts) => {
      const session = await requireSession(agent.opts().session);
      const thread = createThread(
        session.id,
        GENERAL_THREAD_FILE_PATH,
        'new',
        0,
        0,
        fromShell(opts.body),
        { name: 'Agent', type: 'agent' },
      );
      console.log(pc.green(`Created general comment ${thread.id.slice(0, 8)}`));
    });

  agent
    .command('diff')
    .description('Output the unified diff for the current session (includes untracked files)')
    .action(async () => {
      const session = await requireSession(agent.opts().session);
      const ref = session.ref === '__tree__' ? 'work' : session.ref;
      const raw = resolveRef(ref);
      if (!raw.trim()) {
        console.error(pc.dim('No diff content for current session.'));
        process.exit(0);
      }
      process.stdout.write(raw);
    });

  agent
    .command('review-start')
    .description('Announce that a review is under way, so the page can say so')
    .option('--note <text>', 'What is being reviewed', '')
    .action(async (opts) => {
      const session = await requireSession(agent.opts().session);
      startReviewRun(session.id, fromShell(opts.note ?? ''));
      console.log(pc.green('Review marked as in progress'));
    });

  agent
    .command('review-done')
    .description('Announce that the review is finished')
    .action(async () => {
      const session = await requireSession(agent.opts().session);
      finishReviewRun(session.id);
      console.log(pc.green('Review marked as finished'));
    });

  agent
    .command('standards')
    .description("Print the project's review standards and severity labels")
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      if (!isGitRepo()) {
        console.error(pc.red('Error: Not a git repository'));
        process.exit(1);
      }

      const { review } = readRepoConfig(getRepoRoot());
      const severities = review?.severities ?? DEFAULT_SEVERITIES;
      let standards: { path: string; content: string } | null = null;

      if (review?.standards) {
        try {
          standards = {
            path: review.standards,
            content: readFileSync(resolveInRepo(review.standards), 'utf-8'),
          };
        } catch {
          console.error(pc.yellow(`Warning: cannot read ${review.standards} from ${REPO_CONFIG_FILE}`));
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({ severities, standards }, null, 2));
        return;
      }

      console.log(`Severities: ${severities.join(', ')}`);
      if (standards) {
        console.log(`Standards:  ${standards.path}`);
        console.log('');
        console.log(standards.content);
      } else {
        console.log(pc.dim(`No review standards configured in ${REPO_CONFIG_FILE}.`));
      }
    });

  agent
    .command('tour-start')
    .description('Start a new guided tour of the codebase')
    .requiredOption('--topic <text>', 'The question or topic for the tour')
    .option('--body <text>', 'Introductory text for the tour', '')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const session = await requireSession(agent.opts().session);
      const tour = createTour(session.id, fromShell(opts.topic), fromShell(opts.body));
      if (opts.json) {
        console.log(JSON.stringify(tour, null, 2));
        return;
      }
      console.log(pc.green(`Created tour ${tour.id}`));
    });

  agent
    .command('tour-step')
    .description('Add a step to a guided tour')
    .requiredOption('--tour <id>', 'Tour ID')
    .requiredOption('--file <path>', 'File path (relative to repo root)')
    .requiredOption('--line <n>', 'Start line number (1-indexed)', parseInt)
    .option('--end-line <n>', 'End line number (1-indexed)', parseInt)
    .option('--body <text>', 'Narrative text shown in sidebar', '')
    .option('--annotation <text>', 'Short inline annotation on highlighted code', '')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const session = await requireSession(agent.opts().session);
      assertFileExists(opts.file);
      const tourId = resolveTourId(opts.tour, session.id);
      const endLine = opts.endLine ?? opts.line;
      const step = addTourStep(tourId, opts.file, opts.line, endLine, fromShell(opts.body), fromShell(opts.annotation));
      if (opts.json) {
        console.log(JSON.stringify(step, null, 2));
        return;
      }
      console.log(pc.green(`Added step ${step.sortOrder} to tour`));
    });

  agent
    .command('tour-delete')
    .description('Remove a walkthrough')
    .argument('[tour-id]', 'Walkthrough to remove')
    .option('--all', 'Remove every finished walkthrough in this session instead')
    .option('--include-building', 'With --all, also remove one another agent may still be writing')
    .action(async (tourId: string | undefined, opts: { all?: boolean; includeBuilding?: boolean }) => {
      const session = await requireSession(agent.opts().session);
      if (tourId) {
        const resolved = resolveTourId(tourId, session.id);
        deleteTour(resolved);
        console.log(pc.green(`Removed walkthrough ${resolved.slice(0, 8)}`));
        return;
      }
      // Deleting every walkthrough has to be asked for. Reaching it by leaving the id off meant
      // an agent told to "fix the walkthrough" could wipe one a human recorded.
      if (!opts.all) {
        console.error(pc.red('Give a walkthrough id, or --all to remove every one in this session'));
        process.exitCode = 1;
        return;
      }
      deleteToursForSession(session.id, { keepBuilding: !opts.includeBuilding });
      console.log(pc.green('Removed every walkthrough in this session'));
    });

  agent
    .command('tour-done')
    .description('Mark a tour as ready for viewing')
    .requiredOption('--tour <id>', 'Tour ID')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const session = await requireSession(agent.opts().session);
      updateTourStatus(resolveTourId(opts.tour, session.id), 'ready');
      if (opts.json) {
        console.log(JSON.stringify({ ok: true }));
        return;
      }
      console.log(pc.green('Tour marked as ready'));
    });
}
