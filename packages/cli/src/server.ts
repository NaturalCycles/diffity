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
  getDiff,
  getDiffStat,
  getDiffStatForRef,
  getUntrackedFiles,
  getUntrackedDiff,
  getRepoInfo,
  getFileContent,
  getStagedFiles,
  getUnstagedFiles,
  getRecentCommits,
  getFileLineCount,
  resolveBaseRef,
  resolveDiffArgs,
  resolveRef,
  revertFile,
  revertHunk,
  getRefCapabilities,
  getHeadHash,
  isDirty,
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
  type PrComment,
  type ReviewEvent,
} from '@diffity/github';
import { findOrCreateSession } from './session.js';
import { computeDiffFingerprint } from './fingerprint.js';
import { parseDiffStatSummary } from './diff-stat.js';
import { getReviewRun } from './review-run.js';
import { createThread, addReply, getThreadsForSession, markThreadsSubmitted } from './threads.js';
import { handleReviewRoute } from './review-routes.js';
import { handleTourRoute } from './tour-routes.js';
import { sendJson, sendError, readBody } from './http-utils.js';
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
const REVIEW_EVENTS = new Set(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']);

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
}

export function startServer(options: ServerOptions): Promise<ServerResult> {
  const {
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

        if (pathname === '/api/revert-file' && req.method === 'POST') {
          try {
            const body = JSON.parse(await readBody(req));
            const { filePath: path, isUntracked } = body;
            if (!path || typeof path !== 'string') {
              sendError(res, 400, 'Missing filePath');
              return;
            }
            revertFile(path, !!isUntracked);
            sendJson(res, { ok: true });
          } catch (err) {
            sendError(res, 500, `Failed to revert file: ${err}`);
          }
          return;
        }

        if (pathname === '/api/revert-hunk' && req.method === 'POST') {
          try {
            const body = JSON.parse(await readBody(req));
            const { patch } = body;
            if (!patch || typeof patch !== 'string') {
              sendError(res, 400, 'Missing patch');
              return;
            }
            revertHunk(patch);
            sendJson(res, { ok: true });
          } catch (err) {
            sendError(res, 500, `Failed to revert hunk: ${err}`);
          }
          return;
        }

        if (pathname === '/api/open-in-editor' && req.method === 'POST') {
          if (!editorAvailable) {
            sendError(res, 404, 'No editor available');
            return;
          }
          try {
            const body = JSON.parse(await readBody(req));
            const { filePath, line } = body;
            if (typeof filePath !== 'string') {
              sendError(res, 400, 'Missing filePath');
              return;
            }
            const repoRoot = getRepoInfo().root;
            const fullPath = filePath ? resolveInRepo(filePath) : repoRoot;
            const gotoArg = line ? `${fullPath}:${line}` : fullPath;
            execFile('code', [repoRoot, '--goto', gotoArg], { timeout: 5000 }, () => {});
            sendJson(res, { ok: true });
          } catch (err) {
            sendError(res, 500, `Failed to open editor: ${err}`);
          }
          return;
        }

        if (pathname === '/api/overview') {
          try {
            const staged = getStagedFiles();
            const unstaged = getUnstagedFiles();
            const untracked = getUntrackedFiles();

            const fileMap = new Map<string, string>();
            for (const f of staged) {
              fileMap.set(f, 'staged');
            }
            for (const f of unstaged) {
              fileMap.set(f, 'modified');
            }
            for (const f of untracked) {
              fileMap.set(f, 'added');
            }

            const files = Array.from(fileMap.entries()).map(
              ([path, status]) => ({ path, status }),
            );

            sendJson(res, { files });
          } catch (err) {
            sendError(res, 500, `Failed to get overview: ${err}`);
          }
          return;
        }

        if (pathname === '/api/commits') {
          const count = parseInt(url.searchParams.get('count') || '10', 10);
          const skip = parseInt(url.searchParams.get('skip') || '0', 10);
          const search = url.searchParams.get('search') || undefined;
          try {
            const commits = getRecentCommits({ count, skip, search });
            sendJson(res, { commits, hasMore: commits.length === count });
          } catch (err) {
            sendError(res, 500, `Failed to get commits: ${err}`);
          }
          return;
        }

        if (pathname === '/api/diff-fingerprint') {
          const ref = url.searchParams.get('ref');
          sendJson(res, {
            fingerprint: computeDiffFingerprint(ref, diffArgs, includeUntracked),
          });
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

        if (pathname === '/api/diff') {
          const ref = url.searchParams.get('ref');
          const whitespace = url.searchParams.get('whitespace');
          const hiding = whitespace === 'hide';
          const extraArgs = hiding ? ['-w'] : [];
          const baseRef = ref ? resolveBaseRef(ref) : 'HEAD';

          if (ref) {
            const diff = enrichWithLineCounts(parseDiff(resolveRef(ref, extraArgs)), baseRef);
            sendJson(res, { ...diff, suppressed: suppressedByWhitespace(hiding, diff, ref) });
            return;
          }

          const args = hiding ? [...diffArgs, '-w'] : diffArgs;
          const diff = enrichWithLineCounts(parseDiff(getFullDiff(args)), baseRef);
          sendJson(res, { ...diff, suppressed: suppressedByWhitespace(hiding, diff, null) });
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
            sendJson(res, { path: filePath, content: content.split('\n') });
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
          sendJson(res, {
            ...info,
            description: refDescription,
            capabilities,
            sessionId,
            review: sessionId ? getReviewRun(sessionId) : null,
            github: githubRemote,
            editor: editorAvailable,
          });
          return;
        }

        if (pathname === '/api/github/details') {
          if (!githubRemote) {
            sendJson(res, null);
            return;
          }
          const details = fetchGitHubDetails(githubRemote.owner, githubRemote.repo, prNumber);
          sendJson(res, details);
          return;
        }

        if (pathname === '/api/github/create-review' && req.method === 'POST') {
          const details = githubRemote ? fetchGitHubDetails(githubRemote.owner, githubRemote.repo, prNumber) : null;
          if (!githubRemote || !details?.headSha) {
            sendError(res, 400, 'No GitHub PR detected');
            return;
          }
          const localHead = getHeadHash();
          if (localHead !== details.headSha) {
            sendError(res, 409, 'Local branch is out of sync with the PR. Push or pull your git changes first.');
            return;
          }
          if (isDirty()) {
            sendError(res, 409, 'You have uncommitted local changes. Commit or stash them first.');
            return;
          }
          const body = JSON.parse(await readBody(req));
          const comments = (body.comments ?? []) as PrComment[];
          const summary = typeof body.body === 'string' ? body.body : '';
          const event = REVIEW_EVENTS.has(body.event) ? (body.event as ReviewEvent) : 'COMMENT';
          if (!Array.isArray(comments)) {
            sendError(res, 400, 'comments must be an array');
            return;
          }
          // A verdict carries its own meaning; only a plain comment needs something in it.
          if (event === 'COMMENT' && comments.length === 0 && !summary.trim()) {
            sendError(res, 400, 'A comment review needs a summary or at least one comment');
            return;
          }
          const result = createGitHubReview(
            githubRemote.owner,
            githubRemote.repo,
            details.prNumber,
            details.headSha,
            { event, body: summary, comments },
          );
          markThreadsSubmitted(result.submittedThreadIds);
          sendJson(res, result);
          return;
        }

        if (pathname === '/api/github/pull-comments' && req.method === 'POST') {
          if (!githubRemote) {
            sendError(res, 400, 'No GitHub repo detected');
            return;
          }
          const details = fetchGitHubDetails(githubRemote.owner, githubRemote.repo, prNumber);
          if (!details) {
            sendError(res, 400, 'No GitHub PR detected');
            return;
          }
          const body = JSON.parse(await readBody(req));
          const { sessionId: sid } = body;
          if (!sid) {
            sendError(res, 400, 'Missing sessionId');
            return;
          }

          const localHead = getHeadHash();
          if (localHead !== details.headSha) {
            sendError(res, 409, 'Local branch is out of sync with the PR. Push or pull your git changes first.');
            return;
          }
          if (isDirty()) {
            sendError(res, 409, 'You have uncommitted local changes. Commit or stash them first.');
            return;
          }

          const remoteThreads = pullGitHubComments(githubRemote.owner, githubRemote.repo, details.prNumber);
          const localThreads = getThreadsForSession(sid);

          let pulled = 0;
          let skipped = 0;
          for (const rt of remoteThreads) {
            const firstComment = rt.comments[0];
            const alreadyExists = localThreads.some(t =>
              t.filePath === rt.filePath &&
              t.side === rt.side &&
              t.startLine === rt.startLine &&
              t.endLine === rt.endLine &&
              t.comments.some(c => c.body === firstComment.body),
            );
            if (alreadyExists) {
              skipped++;
              continue;
            }
            const thread = createThread(sid, rt.filePath, rt.side, rt.startLine, rt.endLine, firstComment.body, {
              name: firstComment.authorName,
              type: firstComment.authorType,
            });
            for (let i = 1; i < rt.comments.length; i++) {
              const reply = rt.comments[i];
              addReply(thread.id, reply.body, {
                name: reply.authorName,
                type: reply.authorType,
              });
            }
            pulled++;
          }
          sendJson(res, { pulled, skipped });
          return;
        }

        if (pathname === '/api/tree/fingerprint') {
          const raw = getTreeFingerprint();
          const hash = createHash('sha1')
            .update(raw)
            .digest('hex')
            .slice(0, 12);
          sendJson(res, { fingerprint: hash });
          return;
        }

        if (pathname === '/api/tree') {
          try {
            const paths = getTree();
            sendJson(res, { paths });
          } catch (err) {
            sendError(res, 500, `Failed to get tree: ${err}`);
          }
          return;
        }

        if (pathname === '/api/tree/entries') {
          try {
            const dirPath = url.searchParams.get('path') || undefined;
            const entries = getTreeEntries('HEAD', dirPath);
            sendJson(res, { entries });
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
            sendJson(res, { path: filePath, content: content.split('\n') });
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
          sendJson(res, {
            ...info,
            description: 'Repository file browser',
            capabilities: { reviews: true, revert: false, staleness: false },
            sessionId: session.id,
            github: githubRemote,
            editor: editorAvailable,
          });
          return;
        }

        if (handleReviewRoute(req, res, pathname, url)) {
          return;
        }

        if (handleTourRoute(req, res, pathname, url)) {
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
    deregisterInstance(process.pid);
    server.close();
  };

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
        resolve({ port: addr.port, close: closeFn });
      }
    });

    server.listen(currentPort, getBindHost());
  });
}
