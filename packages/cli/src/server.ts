import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createHash } from 'node:crypto';
import { execSync, execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { parseDiff, type ParsedDiff } from '@diffity/parser';
import {
  AGENT_TRAFFIC_HEADER,
  parseOpenInEditorRequest,
  parsePullCommentsRequest,
  parseReviewSubmission,
  parseRevertFileRequest,
  parseRevertHunkRequest,
} from '@diffity/api';
import type {
  ClaimResponse,
  ReviewSession,
  DiffFileResponse,
  DiffFingerprint,
  DiffResponse,
  FileContentResponse,
  LiveStatusResponse,
  PullCommentsResult,
  RepoInfoResponse,
  TreeEntriesResponse,
  TreeFingerprintResponse,
  TreePathsResponse,
} from '@diffity/api';
import {
  getDiff,
  getDiffStat,
  getDiffStatForRef,
  getUntrackedFiles,
  getUntrackedDiff,
  getRepoInfo,
  getFileContent,
  getFileLineCount,
  resolveBaseRef,
  resolveDiffArgs,
  resolveRef,
  revertFile,
  revertHunk,
  getRefCapabilities,
  getHeadHash,
  getDirtyPaths,
  getTree,
  getTreeEntries,
  getTreeFingerprint,
  getWorkingTreeFileContent,
  getWorkingTreeRawFile,
  resolveInRepo,
  WORKING_TREE_REFS,
} from '@diffity/git';
import {
  detectRemote as detectGitHubRemote,
  fetchDetails as fetchGitHubDetails,
  createReview as createGitHubReview,
  pullComments as pullGitHubComments,
  pullThreadState as pullGitHubThreadState,
} from '@diffity/github';
import { findOrCreateSession, resolveSessionId, agentSeenAt, markAgentSeen } from './session.js';
import { resolveMayChangeCode, type SessionPurpose } from './live-permissions.js';
import {
  liveListenerCount,
  liveListenerTotal,
  liveWorkingCount,
  pendingLiveCount,
  reclaimStaleLiveRequests,
  waitForLiveRequest,
} from './live.js';
import { computeDiffFingerprint } from './fingerprint.js';
import { parseDiffStatFiles } from './diff-stat.js';
import { parseDiffStatSummary } from './diff-stat.js';
import { anyReviewInProgress, getReviewRun } from './review-run.js';
import { createThread, addReply, getThreadsForSession, markThreadsSubmitted, setThreadForgeComment, updateThreadStatus } from './threads.js';
import { existingThreadFor } from './github-pull.js';
import { threadsResolvedRemotely } from './github-resolution.js';
import { noteViewerSeen, markViewerGone, viewerSnapshot, viewerIsPresent, viewerHasGone, awakeMs, VIEWER_POLL_MS } from './viewers.js';
import { sinceLastWait } from './live-events.js';
import pc from 'picocolors';
import { shouldShutDown, IDLE_CHECK_MS } from './idle-shutdown.js';
import { handleReviewRoute } from './review-routes.js';
import { serializer } from './serialize.js';
import { handleTourRoute } from './tour-routes.js';
import { sendJson, sendError, withJsonBody } from './http-utils.js';
import {
  registerInstance,
  deregisterInstance
} from './registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
};

/**
 * Repository content is rendered in this origin, so nothing it contains may reach the network.
 * `script-src` still needs 'unsafe-inline' for the inline scripts in the built index.html;
 * markdown is sanitized separately, and every exfiltration sink is closed here.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  // 'wasm-unsafe-eval' is what the syntax highlighter needs: shiki compiles an oniguruma
  // WebAssembly module, which CSP treats as script compilation. It permits WASM only, not eval.
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "connect-src 'self'",
].join('; ');

/**
 * The tree browser only ever needs raw bytes for images. Anything else — a repository's own
 * .html or .svg — would otherwise be rendered in this origin, where it can read the API.
 */
const INLINE_RAW_TYPES = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.svg',
]);

function rawFileHeaders(ext: string): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    // An <img> never runs an SVG's scripts, but navigating straight to the URL would.
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };

  if (INLINE_RAW_TYPES.has(ext) && MIME_TYPES[ext]) {
    headers['Content-Type'] = MIME_TYPES[ext];
    return headers;
  }

  headers['Content-Type'] = 'application/octet-stream';
  headers['Content-Disposition'] = 'attachment';
  return headers;
}

export function getHost(): string {
  return process.env.DIFFITY_HOST?.trim() || 'localhost';
}

// The server exposes the diff, the repository's files and the review comments with no
// authentication, so it must not be reachable beyond this machine unless asked for.
export function getBindHost(): string {
  return process.env.DIFFITY_BIND?.trim() || '127.0.0.1';
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Long enough that a listener is not re-arming constantly, short enough to notice a dead server. */
const MAX_LIVE_WAIT_SECONDS = 900;

/**
 * A waiting listener holds a response open, and node destroys a request that outlives
 * `requestTimeout` — 300s by default, which killed the loop the first time it ran for the full
 * wait. Set here rather than left to the default, so the two numbers cannot drift apart.
 */
const REQUEST_TIMEOUT_MS = (MAX_LIVE_WAIT_SECONDS + 60) * 1000;
const RECLAIM_AFTER_MINUTES = 10;

function isLoopbackBind(host: string): boolean {
  return LOOPBACK_HOSTNAMES.has(host) || host === '::1';
}

// A cross-site page cannot forge these, and same-origin fetches from the UI always satisfy
// them. Navigations are unaffected: they are GET, and Sec-Fetch-Site is `none` when the URL
// is typed rather than followed.
function isSameOriginRequest(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin') {
    return false;
  }

  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }

  try {
    const { hostname } = new URL(origin);
    return LOOPBACK_HOSTNAMES.has(hostname) || hostname === getHost();
  } catch {
    return false;
  }
}

interface ServerOptions {
  /**
   * What the agent launching this said it was here for. Unsaid means derived from who wrote the
   * pull request, which is wrong exactly when work has been handed over.
   */
  purpose?: SessionPurpose;
  port: number;
  portIsExplicit?: boolean;
  diffArgs: string[];
  description?: string;
  effectiveRef?: string;
  /**
   * When the instance was started for a pull request, the commit its diff must be taken
   * from. A `ref` in the URL that disagrees is corrected rather than honoured.
   */
  pinnedRef?: string;
  /** Set in pull-request mode, so details still resolve on a detached checkout. */
  prNumber?: number;
  version?: string;
  /** Overridden only by tests, which cannot wait five minutes to watch a server stop. */
  idleTimings?: { graceMs?: number; checkMs?: number };
  registryInfo?: {
    repoRoot: string;
    repoHash: string;
    repoName: string;
  };
}

function serveStatic(res: ServerResponse, filePath: string) {
  if (!existsSync(filePath)) {
    sendError(res, 404, 'Not found');
    return;
  }
  const ext = extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const content = readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': mime });
  res.end(content);
}

/**
 * Refuses with a 409 naming the files when any of them has uncommitted local changes, answering
 * whether it did. Only the files a comment anchors to matter: anchors are working-tree line
 * numbers, so a commented file must still match the PR head, while dirt elsewhere — a scratch
 * file, an unrelated edit — shifts none of them.
 */
function refusedDirtyFiles(res: ServerResponse, filePaths: string[]): boolean {
  const dirty = new Set(getDirtyPaths());
  const blocked = [...new Set(filePaths)].filter(filePath => dirty.has(filePath));
  if (blocked.length === 0) {
    return false;
  }
  sendError(res, 409, `Uncommitted local changes in ${blocked.join(', ')}. Commit or stash them first.`);
  return true;
}

function descriptionForRef(ref: string): string {
  if (WORKING_TREE_REFS.has(ref)) {
    const labels: Record<string, string> = {
      staged: 'Staged changes',
      unstaged: 'Unstaged changes',
      work: 'All changes',
      '.': 'All changes',
    };
    return labels[ref] || ref;
  }
  if (ref.includes('..')) {
    return ref;
  }
  return `Changes from ${ref}`;
}

interface ServerResult {
  port: number;
  close: () => void;
  /** Exposed so a test can pin it against the longest wait a listener may ask for. */
  requestTimeoutMs: number;
}

export function startServer(options: ServerOptions): Promise<ServerResult> {
  const {
    purpose,
    port,
    portIsExplicit,
    diffArgs,
    description,
    effectiveRef,
    version,
    registryInfo,
    pinnedRef,
    prNumber,
  } = options;

  const includeUntracked = diffArgs.length === 0;

  /**
   * How much whitespace hiding removed. A filtered diff renders fewer files and lines than the
   * forge shows, so the page has to be able to name the difference rather than leave the reader
   * to wonder why the numbers disagree.
   */
  function suppressedByWhitespace(
    hiding: boolean,
    filtered: ParsedDiff,
    ref: string | null,
  ): { files: number; lines: number } | null {
    if (!hiding) {
      return null;
    }

    const unfiltered = parseDiffStatSummary(ref ? getDiffStatForRef(ref) : getDiffStat(diffArgs));
    const shownLines = filtered.stats.totalAdditions + filtered.stats.totalDeletions;

    return {
      files: Math.max(0, unfiltered.files - filtered.stats.filesChanged),
      lines: Math.max(0, unfiltered.insertions + unfiltered.deletions - shownLines),
    };
  }

  function enrichWithLineCounts(diff: ParsedDiff, baseRef: string): ParsedDiff {
    for (const file of diff.files) {
      if (file.status === 'added' || file.isBinary) {
        continue;
      }
      const path = file.oldPath || file.newPath;
      const count = getFileLineCount(path, baseRef);
      if (count !== null) {
        file.oldFileLineCount = count;
      }
    }
    return diff;
  }

  function getFullDiff(args: string[]): string {
    let raw = getDiff(args);
    if (includeUntracked) {
      const untrackedFiles = getUntrackedFiles();
      if (untrackedFiles.length > 0) {
        raw += '\n' + getUntrackedDiff(untrackedFiles);
      }
    }
    return raw;
  }

  const githubRemote = detectGitHubRemote();
  const uiDir = join(__dirname, 'ui/client');

  let editorAvailable: 'vscode' | null = null;
  try {
    execSync('which code', { stdio: 'pipe' });
    editorAvailable = 'vscode';
  } catch {
    // VS Code CLI not found
  }

  // The ref whose page somebody last looked at on this instance. One server gets reused for other
  // refs and for the tree, so the startup ref is not what an agent should follow — and the page's
  // own polls, never the agent's traffic, are what say where the reader actually is.
  let lastViewedRef: string | null = null;

  // Who wrote the pull request does not change between two questions asked a minute apart, and
  // the lookup is a subprocess on a path that is meant to feel immediate. The promise is what is
  // remembered, so concurrent first asks share one lookup.
  let authorshipCache: Promise<{ viewerDidAuthor?: boolean } | null> | undefined;
  function authorship(): Promise<{ viewerDidAuthor?: boolean } | null> {
    authorshipCache ??= githubRemote
      ? fetchGitHubDetails(githubRemote.owner, githubRemote.repo, prNumber)
      : Promise.resolve(null);
    return authorshipCache;
  }

  // Both mutating GitHub routes were loop-atomic while the gh boundary was synchronous: a second
  // submit always saw the first one's comments, and a second pull saw its threads. What
  // serialized by accident serializes on purpose.
  const oneGhMutationAtATime = serializer();

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url || '/', `http://${getHost()}:${port}`);
        const pathname = url.pathname;

        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method !== 'GET' && req.method !== 'HEAD' && !isSameOriginRequest(req)) {
          sendError(res, 403, 'Cross-origin request rejected');
          return;
        }

        // A pull request's diff has to match the one GitHub shows, so a stale ref in the URL —
        // a tab left open from an earlier session, a bookmark — is corrected on load. Switching
        // revision inside the UI is a client-side navigation and never reaches this.
        if (pinnedRef && pathname === '/diff' && url.searchParams.get('ref') !== pinnedRef) {
          url.searchParams.set('ref', pinnedRef);
          res.writeHead(302, { Location: `${pathname}?${url.searchParams.toString()}` });
          res.end();
          return;
        }

        // Its own endpoint rather than a field on /api/info. Whether an agent is listening changes
        // as one arms and answers, and react-query keeps an unchanged object's identity — so
        // carrying this on the info payload made every consumer of it re-render each time a
        // listener came or went, which reads as the page reloading under you.
        // The page asks about the session it is showing, which is the one for its ref — not
        // whichever session the ambient current-session file last named, which is shared by every
        // worktree using this data directory.
        const liveSessionId = (): string => {
          const asked = url.searchParams.get('session');
          if (asked) {
            return resolveSessionId(asked);
          }
          return findOrCreateSession(url.searchParams.get('ref') || effectiveRef || 'work').id;
        };

        // The page says whether it is there, rather than being inferred from traffic it stops
        // making: react query pauses polling on a hidden tab, so a window can be open and silent.
        if (pathname === '/api/viewer' && req.method === 'POST') {
          noteViewerSeen();
          sendJson(res, { ok: true });
          return;
        }

        // Sent on `pagehide` as a beacon, so a closed tab is known at once instead of after the
        // idle window has run out.
        if (pathname === '/api/viewer/gone' && req.method === 'POST') {
          markViewerGone();
          sendJson(res, { ok: true });
          return;
        }

        // The agent asks here instead of reading the shared current-session file, which any
        // tab's info poll rewrites. Ensuring is deliberate: an agent arriving after a commit
        // needs the carry-forward that findOrCreateSession performs.
        if (pathname === '/api/sessions/ensure' && req.method === 'POST') {
          const ref = lastViewedRef ?? effectiveRef;
          if (!ref) {
            sendError(res, 400, 'This server has no review ref');
            return;
          }
          sendJson(res, findOrCreateSession(ref) satisfies ReviewSession);
          return;
        }

        if (pathname === '/api/live/status') {
          const sid = liveSessionId();
          sendJson(res, {
            enabled: isLoopbackBind(getBindHost()),
            listening: sid ? liveListenerCount(sid) > 0 : false,
            working: sid ? liveWorkingCount(sid) > 0 : false,
            waiting: sid ? pendingLiveCount(sid) : 0,
            mayChangeCode: resolveMayChangeCode(purpose, await authorship()),
            viewerPresent: viewerIsPresent(viewerSnapshot(), awakeMs()),
          } satisfies LiveStatusResponse);
          return;
        }

        if (pathname === '/api/live/claim' && req.method === 'POST') {
          if (!isLoopbackBind(getBindHost())) {
            sendError(res, 403, 'Live mode is only available on a loopback bind');
            return;
          }
          const sid = liveSessionId();
          if (!sid) {
            sendError(res, 400, 'No review session');
            return;
          }
          // Anything left claimed by a listener that went away goes back in the queue first,
          // otherwise the thread would say the agent was working on it forever.
          reclaimStaleLiveRequests(RECLAIM_AFTER_MINUTES);
          const waitSeconds = Number(url.searchParams.get('wait') ?? '0');
          const waitMs = Number.isFinite(waitSeconds)
            ? Math.min(Math.max(waitSeconds, 0), MAX_LIVE_WAIT_SECONDS) * 1000
            : 0;
          // The listener going away is the only reliable signal that it is no longer there, and
          // presence is what the page shows. Without this it stayed counted until the wait ran out.
          const listenerGone = new AbortController();
          req.on('close', () => listenerGone.abort());

          const mayChangeCode = resolveMayChangeCode(purpose, await authorship());
          // What happened while the last agent was parked, before this wait resets the watermark.
          const since = sinceLastWait(
            getThreadsForSession(sid).map(thread => thread.submittedAt),
            agentSeenAt(sid),
          );
          markAgentSeen(sid);

          // Nobody is going to ask anything through a window that is not open. Waiting anyway costs
          // a parked request here and a re-arm every few minutes at the other end, forever.
          //
          // A window that has never been open is a different matter: an agent is usually armed
          // before the reader opens the page, so that case waits.
          if (viewerHasGone(viewerSnapshot(), awakeMs())) {
            sendJson(res, { request: null, since, viewerPresent: false, viewerGone: true } satisfies ClaimResponse);
            return;
          }
          // Set by the watcher below, read by the handler: `listenerGone` is aborted both when the
          // agent hangs up and when the reader closes the page, and those need opposite responses —
          // one has no socket left to write to, the other is waiting for an answer.
          let endedBecauseViewerLeft = false;
          const viewerWatch = setInterval(() => {
            if (viewerHasGone(viewerSnapshot(), awakeMs())) {
              endedBecauseViewerLeft = true;
              listenerGone.abort();
            }
          }, VIEWER_POLL_MS);
          const stopWatching = (): void => clearInterval(viewerWatch);
          req.on('close', stopWatching);

          waitForLiveRequest(sid, waitMs, listenerGone.signal).then(
            request => {
              stopWatching();
              // The connection may already be gone; writing to it would throw rather than help.
              if (res.writableEnded) {
                return;
              }
              if (endedBecauseViewerLeft) {
                sendJson(res, { request: null, since, viewerPresent: false, viewerGone: true } satisfies ClaimResponse);
                return;
              }
              if (listenerGone.signal.aborted) {
                return;
              }
              const viewerPresent = viewerIsPresent(viewerSnapshot(), awakeMs());
              if (!request) {
                sendJson(res, { request: null, since, viewerPresent, viewerGone: false } satisfies ClaimResponse);
                return;
              }
              // Carried on the request rather than left for the agent to look up: a rule nobody
              // has to remember is a rule that holds.
              sendJson(res, {
                request: { ...request, mayChangeCode },
                since,
                viewerPresent,
                viewerGone: false,
              } satisfies ClaimResponse);
            },
            err => {
              stopWatching();
              if (!res.writableEnded && !listenerGone.signal.aborted) {
                sendError(res, 500, `Failed to wait for a live request: ${err}`);
              }
            },
          );
          return;
        }

        if (pathname === '/api/revert-file' && req.method === 'POST') {
          withJsonBody(res, req, 'Failed to revert file', parseRevertFileRequest, (body) => {
            revertFile(body.filePath, body.isUntracked === true);
            sendJson(res, { ok: true });
          });
          return;
        }

        if (pathname === '/api/revert-hunk' && req.method === 'POST') {
          withJsonBody(res, req, 'Failed to revert hunk', parseRevertHunkRequest, (body) => {
            revertHunk(body.patch);
            sendJson(res, { ok: true });
          });
          return;
        }

        if (pathname === '/api/open-in-editor' && req.method === 'POST') {
          if (!editorAvailable) {
            sendError(res, 404, 'No editor available');
            return;
          }
          withJsonBody(res, req, 'Failed to open editor', parseOpenInEditorRequest, (body) => {
            const repoRoot = getRepoInfo().root;
            const fullPath = body.filePath ? resolveInRepo(body.filePath) : repoRoot;
            const gotoArg = body.line ? `${fullPath}:${body.line}` : fullPath;
            execFile('code', [repoRoot, '--goto', gotoArg], { timeout: 5000 }, () => {});
            sendJson(res, { ok: true });
          });
          return;
        }



        if (pathname === '/api/diff-fingerprint') {
          const ref = url.searchParams.get('ref');
          sendJson(res, {
            fingerprint: computeDiffFingerprint(ref, diffArgs, includeUntracked),
            // Per file as well as overall, so the page can say which files moved rather than
            // declaring the whole diff stale because an agent touched one of them.
            files: parseDiffStatFiles(
              ref ? getDiffStatForRef(ref) : getDiffStat(diffArgs),
            ),
          } satisfies DiffFingerprint);
          return;
        }

        if (pathname === '/api/diff/ref') {
          const ref = url.searchParams.get('ref');
          const resolved = ref ? resolveDiffArgs(ref) : null;

          if (resolved) {
            sendJson(res, { args: resolved.args.join(' ') });
          } else {
            const args = diffArgs.length > 0 ? diffArgs : ['HEAD'];
            sendJson(res, { args: args.join(' ') });
          }
          return;
        }

        // One file, so a page that knows only one file moved can replace only that one — reloading
        // the whole diff to see it costs the reader their collapse states and their place.
        if (pathname === '/api/diff/file') {
          const ref = url.searchParams.get('ref');
          const requested = url.searchParams.get('path');
          if (!requested) {
            sendError(res, 400, 'Missing path');
            return;
          }
          const hiding = url.searchParams.get('whitespace') === 'hide';
          const extraArgs = hiding ? ['-w'] : [];
          const baseRef = ref ? resolveBaseRef(ref) : 'HEAD';

          // Containment is checked before the path reaches git as a pathspec; the absolute form it
          // returns is what git is given, since a pathspec outside the repository is a way out of it.
          let contained: string;
          try {
            contained = resolveInRepo(requested);
          } catch {
            sendError(res, 400, 'Path is outside the repository');
            return;
          }

          const raw = ref
            ? resolveRef(ref, [...extraArgs, '--', contained])
            : getFullDiff([...(hiding ? [...diffArgs, '-w'] : diffArgs), '--', contained]);
          const parsed = enrichWithLineCounts(parseDiff(raw), baseRef);
          // Null rather than an empty diff: the file may no longer differ at all, which the page
          // has to be able to tell from "here it is, unchanged".
          sendJson(res, { file: parsed.files[0] ?? null } satisfies DiffFileResponse);
          return;
        }

        if (pathname === '/api/diff') {
          const ref = url.searchParams.get('ref');
          const whitespace = url.searchParams.get('whitespace');
          const hiding = whitespace === 'hide';
          const extraArgs = hiding ? ['-w'] : [];
          const baseRef = ref ? resolveBaseRef(ref) : 'HEAD';

          if (ref) {
            const diff = enrichWithLineCounts(parseDiff(resolveRef(ref, extraArgs)), baseRef);
            sendJson(res, { ...diff, suppressed: suppressedByWhitespace(hiding, diff, ref) } satisfies DiffResponse);
            return;
          }

          const args = hiding ? [...diffArgs, '-w'] : diffArgs;
          const diff = enrichWithLineCounts(parseDiff(getFullDiff(args)), baseRef);
          sendJson(res, { ...diff, suppressed: suppressedByWhitespace(hiding, diff, null) } satisfies DiffResponse);
          return;
        }

        if (pathname.startsWith('/api/file/')) {
          const filePath = decodeURIComponent(
            pathname.slice('/api/file/'.length),
          );
          const ref = url.searchParams.get('ref') || undefined;
          const baseRef = ref ? resolveBaseRef(ref) : 'HEAD';
          try {
            const content = getFileContent(filePath, baseRef);
            sendJson(res, { path: filePath, content: content.split('\n') } satisfies FileContentResponse);
          } catch {
            sendError(res, 404, `File not found: ${filePath}`);
          }
          return;
        }

        if (pathname === '/api/info') {
          const ref = url.searchParams.get('ref') || effectiveRef;
          const info = getRepoInfo();
          let refDescription =
            description || diffArgs.join(' ') || 'Unstaged changes';
          if (url.searchParams.get('ref')) {
            refDescription = descriptionForRef(url.searchParams.get('ref')!);
          }
          const capabilities = getRefCapabilities(ref);
          let sessionId: string | null = null;
          if (ref) {
            const session = findOrCreateSession(ref);
            sessionId = session.id;
          }
          if (ref && req.headers[AGENT_TRAFFIC_HEADER] !== '1') {
            lastViewedRef = ref;
          }
          sendJson(res, {
            ...info,
            description: refDescription,
            capabilities,
            sessionId,
            review: sessionId ? getReviewRun(sessionId) : null,
            github: githubRemote,
            editor: editorAvailable,
          } satisfies RepoInfoResponse);
          return;
        }

        if (pathname === '/api/github/details') {
          if (!githubRemote) {
            sendJson(res, null);
            return;
          }
          const details = await fetchGitHubDetails(githubRemote.owner, githubRemote.repo, prNumber);
          sendJson(res, details);
          return;
        }

        if (pathname === '/api/github/create-review' && req.method === 'POST') {
          const details = githubRemote ? await fetchGitHubDetails(githubRemote.owner, githubRemote.repo, prNumber) : null;
          if (!githubRemote || !details?.headSha) {
            sendError(res, 400, 'No GitHub PR detected');
            return;
          }
          const localHead = getHeadHash();
          if (localHead !== details.headSha) {
            sendError(res, 409, 'Local branch is out of sync with the PR. Push or pull your git changes first.');
            return;
          }
          withJsonBody(res, req, 'Failed to create review', parseReviewSubmission, (submission) => oneGhMutationAtATime(async () => {
            // A verdict carries its own meaning; only a plain comment needs something in it.
            if (submission.event === 'COMMENT' && submission.comments.length === 0 && !submission.body.trim()) {
              sendError(res, 400, 'A comment review needs a summary or at least one comment');
              return;
            }
            if (refusedDirtyFiles(res, submission.comments.map(comment => comment.filePath))) {
              return;
            }
            const result = await createGitHubReview(
              githubRemote.owner,
              githubRemote.repo,
              details.prNumber,
              details.headSha,
              submission,
            );
            const sentBodies = new Map(submission.comments.map(comment => [comment.threadId, comment.body]));
            const forgeIds = new Map(result.commentIds.map(entry => [entry.threadId, entry.githubCommentId]));
            markThreadsSubmitted(
              result.submittedThreadIds.map(threadId => ({
                threadId,
                body: sentBodies.get(threadId),
                githubCommentId: forgeIds.get(threadId),
              })),
              {
                reviewUrl: result.reviewUrl,
                headSha: details.headSha,
              },
            );
            sendJson(res, result);
          }));
          return;
        }

        if (pathname === '/api/github/pull-comments' && req.method === 'POST') {
          if (!githubRemote) {
            sendError(res, 400, 'No GitHub repo detected');
            return;
          }
          const details = await fetchGitHubDetails(githubRemote.owner, githubRemote.repo, prNumber);
          if (!details) {
            sendError(res, 400, 'No GitHub PR detected');
            return;
          }
          const localHead = getHeadHash();
          if (localHead !== details.headSha) {
            sendError(res, 409, 'Local branch is out of sync with the PR. Push or pull your git changes first.');
            return;
          }
          withJsonBody(res, req, 'Failed to pull comments', parsePullCommentsRequest, (body) => oneGhMutationAtATime(async () => {
            const sid = body.sessionId;
            const [remoteThreads, remoteState] = await Promise.all([
              pullGitHubComments(githubRemote.owner, githubRemote.repo, details.prNumber),
              pullGitHubThreadState(githubRemote.owner, githubRemote.repo, details.prNumber),
            ]);
            const localThreads = getThreadsForSession(sid);

            // Only incoming threads anchor anything; threads already known re-pull freely.
            const incoming = remoteThreads.filter(rt => !existingThreadFor(localThreads, rt));
            if (refusedDirtyFiles(res, incoming.map(rt => rt.filePath))) {
              return;
            }

            const settled = remoteState ? threadsResolvedRemotely(localThreads, remoteState) : [];
            for (const threadId of settled) {
              updateThreadStatus(threadId, 'resolved');
            }

            let pulled = 0;
            let skipped = 0;
            for (const rt of remoteThreads) {
              const firstComment = rt.comments[0];
              const existing = existingThreadFor(localThreads, rt);
              if (existing) {
                skipped++;
                // A thread sent before ids were recorded is recognised by wording once more, and
                // from then on by id. The snapshot is updated too, so a second wording twin in
                // this same pull sees the claimed id instead of overwriting it.
                if (existing.githubCommentId == null) {
                  setThreadForgeComment(existing.id, rt.firstCommentId);
                  existing.githubCommentId = rt.firstCommentId;
                }
                continue;
              }
              const thread = createThread(sid, rt.filePath, rt.side, rt.startLine, rt.endLine, firstComment.body, {
                name: firstComment.authorName,
                type: firstComment.authorType,
              });
              setThreadForgeComment(thread.id, rt.firstCommentId);
              for (let i = 1; i < rt.comments.length; i++) {
                const reply = rt.comments[i];
                addReply(thread.id, reply.body, {
                  name: reply.authorName,
                  type: reply.authorType,
                });
              }
              pulled++;
            }
            sendJson(res, { pulled, skipped, resolved: settled.length, resolutionUnavailable: remoteState === null } satisfies PullCommentsResult);
          }));
          return;
        }

        if (pathname === '/api/tree/fingerprint') {
          const raw = getTreeFingerprint();
          const hash = createHash('sha1')
            .update(raw)
            .digest('hex')
            .slice(0, 12);
          sendJson(res, { fingerprint: hash } satisfies TreeFingerprintResponse);
          return;
        }

        if (pathname === '/api/tree') {
          try {
            const paths = getTree();
            sendJson(res, { paths } satisfies TreePathsResponse);
          } catch (err) {
            sendError(res, 500, `Failed to get tree: ${err}`);
          }
          return;
        }

        if (pathname === '/api/tree/entries') {
          try {
            const dirPath = url.searchParams.get('path') || undefined;
            const entries = getTreeEntries('HEAD', dirPath);
            sendJson(res, { entries } satisfies TreeEntriesResponse);
          } catch (err) {
            sendError(res, 500, `Failed to get tree entries: ${err}`);
          }
          return;
        }

        if (pathname.startsWith('/api/tree/file/')) {
          const filePath = decodeURIComponent(
            pathname.slice('/api/tree/file/'.length),
          );
          try {
            const content = getWorkingTreeFileContent(filePath);
            sendJson(res, { path: filePath, content: content.split('\n') } satisfies FileContentResponse);
          } catch {
            sendError(res, 404, `File not found: ${filePath}`);
          }
          return;
        }

        if (pathname.startsWith('/api/tree/raw/')) {
          const filePath = decodeURIComponent(
            pathname.slice('/api/tree/raw/'.length),
          );
          try {
            const { data } = getWorkingTreeRawFile(filePath);
            res.writeHead(200, rawFileHeaders(extname(filePath)));
            res.end(data);
          } catch {
            sendError(res, 404, `File not found: ${filePath}`);
          }
          return;
        }

        if (pathname === '/api/tree/info') {
          const info = getRepoInfo();
          const session = findOrCreateSession('__tree__');
          if (req.headers[AGENT_TRAFFIC_HEADER] !== '1') {
            lastViewedRef = '__tree__';
          }
          sendJson(res, {
            ...info,
            description: 'Repository file browser',
            capabilities: { reviews: true, revert: false, staleness: false },
            sessionId: session.id,
            github: githubRemote,
            editor: editorAvailable,
          } satisfies RepoInfoResponse);
          return;
        }

        if (handleReviewRoute(req, res, pathname, url)) {
          return;
        }

        if (handleTourRoute(req, res, pathname, url, ref => {
          if (req.headers[AGENT_TRAFFIC_HEADER] !== '1') {
            lastViewedRef = ref;
          }
        })) {
          return;
        }

        let filePath = join(uiDir, pathname === '/' ? 'index.html' : pathname);
        if (!existsSync(filePath)) {
          filePath = join(uiDir, 'index.html');
        }
        serveStatic(res, filePath);
      } catch (err) {
        if (!res.headersSent) {
          sendError(res, 500, `${err instanceof Error ? err.message : err}`);
        }
      }
    },
  );

  const closeFn = () => {
    clearInterval(idleWatch);
    deregisterInstance(process.pid);
    server.close();
  };

    // A server outlives its reader otherwise. Nothing is lost by stopping: findings, walkthroughs
    // and review state live in the database, and running `diffity` again serves the same review.
    const startedAt = awakeMs();
    // Whole-instance questions, not startup-session ones: an agent parks on the session the
    // reader is viewing — the tree, or a review carried forward by a commit — so a guard keyed
    // to the startup ref would stop the server under a listener it never counted.
    const ownRepoRoot = registryInfo?.repoRoot ?? getRepoInfo().root;
    const idleWatch = setInterval(() => {
      const viewer = viewerSnapshot();

      if (
        !shouldShutDown({
          viewerGone: viewerHasGone(viewer, awakeMs()),
          everSeen: viewer.everSeen,
          idleForMs: awakeMs() - (viewer.lastSeenAwake || startedAt),
          listeners: liveListenerTotal(),
          reviewInProgress: anyReviewInProgress(ownRepoRoot),
          graceMs: options.idleTimings?.graceMs,
        })
      ) {
        return;
      }

      console.log(
        pc.dim(
          viewer.everSeen
            ? '  Review page closed — stopping. Run diffity again to pick it back up.'
            : '  Nobody opened this review — stopping. Run diffity again to pick it back up.',
        ),
      );
      closeFn();
      process.exit(0);
    }, options.idleTimings?.checkMs ?? IDLE_CHECK_MS);
    idleWatch.unref();


  return new Promise((resolve, reject) => {
    let currentPort = port;
    let retries = 0;
    const maxRetries = portIsExplicit ? 0 : 10;

    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && retries < maxRetries) {
        retries++;
        server.close();
        currentPort++;
        setTimeout(() => server.listen(currentPort, getBindHost()), 200);
      } else if (err.code === 'EADDRINUSE' && portIsExplicit) {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    };

    server.on('error', onError);
    server.on('listening', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') {
        if (!isLoopbackBind(getBindHost())) {
          console.warn(
            `  Warning: listening on ${getBindHost()}:${addr.port} — the diff, the repository files and the review comments are readable by anyone who can reach this machine.`,
          );
        }
        if (effectiveRef) {
          findOrCreateSession(effectiveRef);
        }
        if (registryInfo) {
          registerInstance({
            pid: process.pid,
            port: addr.port,
            repoRoot: registryInfo.repoRoot,
            repoHash: registryInfo.repoHash,
            repoName: registryInfo.repoName,
            ref: effectiveRef || 'work',
            description: description || 'Unstaged changes',
            startedAt: new Date().toISOString(),
            version,
          });
        }
        resolve({ port: addr.port, close: closeFn, requestTimeoutMs: server.requestTimeout });
      }
    });

    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.listen(currentPort, getBindHost());
  });
}
