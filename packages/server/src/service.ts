import { parseDiff } from '@diffity/parser';
import { DEFAULT_SEVERITIES, parseRepoConfig, REPO_CONFIG_FILE } from '@diffity/git';
import type { CommentThread, DiffResponse, GitHubDetails, Suppressed } from '@diffity/api';
import { isSha, isSafeRepoPath, isRepoName, type Mirrors, type NameStatus } from './git.js';
import type { GitHubAccess, GitHubApi } from './github.js';
import type { PrMeta, ReviewSessionRecord, Reviews } from './reviews.js';
import { followRename, reanchor, splitLines } from './anchor.js';

/** A failure worth telling the caller about in words, with the HTTP status it amounts to. */
export class ServiceError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface CreateSessionInput {
  repo: string;
  pr?: number;
  base?: string;
  head?: string;
  patch?: string;
}

export interface CreatedSession {
  session: ReviewSessionRecord;
  created: boolean;
  carried: number;
  files: NameStatus[];
}

export interface Standards {
  severities: string[];
  standards: { path: string; content: string } | null;
}

const MAX_PATCH_BYTES = 10 * 1024 * 1024;
const CACHE_ENTRIES = 256;

export function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const match = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(slug.trim());
  if (!match || !isRepoName(match[1]) || !isRepoName(match[2])) {
    throw new ServiceError(`repo must be "owner/name", got "${slug}"`);
  }
  return { owner: match[1], repo: match[2] };
}

/** What a session's diff is shown as, and what its GitHub details say, independent of any request. */
export function describeSession(session: ReviewSessionRecord): string {
  if (session.prNumber !== null) {
    return session.prMeta?.title ? `#${session.prNumber} ${session.prMeta.title}` : `Pull request #${session.prNumber}`;
  }
  const head = session.kind === 'patch' ? `patch (tree ${session.headSha.slice(0, 7)})` : session.headSha.slice(0, 7);
  return `${session.baseSha.slice(0, 7)}..${head}`;
}

export function gitHubDetailsFor(session: ReviewSessionRecord): GitHubDetails | null {
  if (session.prNumber === null || !session.prMeta) {
    return null;
  }
  return {
    prNumber: session.prNumber,
    prTitle: session.prMeta.title,
    prUrl: session.prMeta.url,
    prCreatedAt: session.prMeta.createdAt,
    headSha: session.headSha,
    commentCount: 0,
    prAuthor: session.prMeta.author,
    viewerDidAuthor: false,
    prBody: session.prMeta.body,
    reviews: [],
  };
}

function parseShortStat(stat: string): { files: number; lines: number } {
  const files = /(\d+) files? changed/.exec(stat);
  const insertions = /(\d+) insertions?\(\+\)/.exec(stat);
  const deletions = /(\d+) deletions?\(-\)/.exec(stat);
  return {
    files: files ? Number(files[1]) : 0,
    lines: (insertions ? Number(insertions[1]) : 0) + (deletions ? Number(deletions[1]) : 0),
  };
}

/** Keeps the most recently used entries. Every key names immutable content, so nothing expires. */
class Cache<T> {
  private readonly entries = new Map<string, Promise<T>>();

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const loading = load();
    this.entries.set(key, loading);
    loading.catch(() => this.entries.delete(key));
    if (this.entries.size > CACHE_ENTRIES) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    return loading;
  }
}

export class ReviewService {
  private readonly diffCache = new Cache<string>();
  private readonly filesCache = new Cache<NameStatus[]>();

  constructor(
    readonly reviews: Reviews,
    private readonly mirrors: Mirrors,
    private readonly github: GitHubApi,
    private readonly access: GitHubAccess,
    readonly publicUrl: URL,
  ) {}

  sessionUrl(sessionId: string): string {
    return new URL(`/s/${sessionId}/`, this.publicUrl).href;
  }

  requireSession(userId: string, idOrPrefix: string): ReviewSessionRecord {
    const session = this.reviews.getSession(userId, idOrPrefix);
    if (!session) {
      throw new ServiceError(`No session matches ${idOrPrefix}`, 404);
    }
    return session;
  }

  async createSession(userId: string, input: CreateSessionInput): Promise<CreatedSession> {
    const slug = parseRepoSlug(input.repo);
    const mode = sessionMode(input);
    const token = await this.access.tokenFor(userId);
    // GitHub is the access check: the mirror is shared, so what a user may see is decided here,
    // with their own credentials, before anything is fetched on their behalf.
    const repoInfo = await this.github.getRepo(token, slug.owner, slug.repo);
    if (!repoInfo) {
      throw new ServiceError(
        token
          ? `${slug.owner}/${slug.repo} does not exist or your GitHub token cannot read it`
          : `${slug.owner}/${slug.repo} is not readable without a GitHub token; add one at ${new URL('/settings', this.publicUrl).href}`,
        404,
      );
    }
    const { owner, name: repo } = repoInfo;

    let baseSha: string;
    let headSha: string;
    let prMeta: PrMeta | null = null;
    let prNumber: number | null = null;

    if (mode === 'pr') {
      prNumber = input.pr!;
      const pull = await this.github.getPull(token, owner, repo, prNumber);
      if (!pull) {
        throw new ServiceError(`${owner}/${repo} has no pull request #${prNumber}`, 404);
      }
      headSha = await this.mirrors.fetchPullHead(owner, repo, token, prNumber);
      await this.mirrors.fetchCommits(owner, repo, token, [pull.baseSha]);
      // What GitHub shows is the change since the branches diverged, not against the base's tip.
      baseSha = await this.mirrors.mergeBase(owner, repo, token, pull.baseSha, headSha);
      prMeta = {
        title: pull.title,
        url: pull.url,
        createdAt: pull.createdAt,
        author: pull.author,
        body: pull.body,
        headRef: pull.headRef,
        baseRef: pull.baseRef,
      };
    } else if (mode === 'shas') {
      baseSha = input.base!;
      headSha = input.head!;
      await this.mirrors.fetchCommits(owner, repo, token, [baseSha, headSha]);
    } else {
      baseSha = input.base!;
      await this.mirrors.fetchCommits(owner, repo, token, [baseSha]);
      try {
        headSha = await this.mirrors.applyPatch(owner, repo, token, baseSha, input.patch!);
      } catch (err) {
        throw new ServiceError(err instanceof Error ? err.message : String(err));
      }
    }

    const { session, created } = this.reviews.findOrCreateSession({
      userId,
      owner,
      repo,
      kind: mode,
      prNumber,
      prMeta,
      baseSha,
      headSha,
    });
    const carried = created && prNumber !== null ? await this.carryForward(session) : 0;
    return { session, created, carried, files: await this.changedFiles(session) };
  }

  /**
   * A pull request that moved on gets a new session, and anything still open has to come along:
   * acting on the findings is what moves the head. Lines follow their code where it can be found.
   */
  private async carryForward(session: ReviewSessionRecord): Promise<number> {
    const priors = this.reviews.priorPrSessions(session.userId, session.repoId, session.prNumber!, session.id);
    if (priors.length === 0) {
      return 0;
    }
    const moved = this.reviews.moveOpenWork(session.userId, priors.map(prior => prior.id), session.id);
    if (moved === 0) {
      return 0;
    }
    const token = await this.access.tokenFor(session.userId);
    const moves = new Map<string, string>();
    for (const head of new Set(priors.map(prior => prior.headSha))) {
      if (head === session.headSha) {
        continue;
      }
      try {
        for (const entry of await this.mirrors.renames(session.owner, session.repo, token, head, session.headSha)) {
          moves.set(entry.oldPath, entry.newPath);
        }
      } catch {
        // A head the mirror no longer has cannot say what was renamed; the paths stay as they are.
      }
    }
    const threads = this.reviews.threadsForSession(session.userId, session.id, 'open');
    for (const thread of threads) {
      const path = followRename(thread.filePath, moves);
      if (path !== thread.filePath) {
        this.reviews.updateThreadPath(session.userId, thread.id, path);
        thread.filePath = path;
      }
    }
    const anchored = threads.filter(thread => thread.side === 'new' && thread.anchorContent && isSafeRepoPath(thread.filePath));
    const contents = await this.mirrors.readFiles(
      session.owner,
      session.repo,
      token,
      session.headSha,
      [...new Set(anchored.map(thread => thread.filePath))],
    );
    for (const thread of anchored) {
      const content = contents.get(thread.filePath);
      if (content == null) {
        continue;
      }
      const range = reanchor(thread.anchorContent!, splitLines(content), thread.startLine);
      if (range && range.startLine !== thread.startLine) {
        this.reviews.updateThreadLines(session.userId, thread.id, range.startLine, range.endLine);
      }
    }
    return moved;
  }

  private cacheKey(session: ReviewSessionRecord, ...parts: string[]): string {
    return [session.owner, session.repo, session.baseSha, session.headSha, ...parts].join('\0');
  }

  async diffText(session: ReviewSessionRecord, options: { ignoreWhitespace?: boolean; path?: string } = {}): Promise<string> {
    if (options.path !== undefined && !isSafeRepoPath(options.path)) {
      throw new ServiceError(`Not a repository path: ${options.path}`);
    }
    const token = await this.access.tokenFor(session.userId);
    return this.diffCache.get(
      this.cacheKey(session, options.ignoreWhitespace ? 'w' : '', options.path ?? ''),
      () => this.mirrors.diff(session.owner, session.repo, token, session.baseSha, session.headSha, options),
    );
  }

  async changedFiles(session: ReviewSessionRecord): Promise<NameStatus[]> {
    const token = await this.access.tokenFor(session.userId);
    return this.filesCache.get(this.cacheKey(session, 'names'), () =>
      this.mirrors.nameStatus(session.owner, session.repo, token, session.baseSha, session.headSha),
    );
  }

  /** What `/api/diff` answers: the parsed diff, the base side's line counts, and what `-w` hid. */
  async parsedDiff(session: ReviewSessionRecord, options: { ignoreWhitespace?: boolean; path?: string } = {}): Promise<DiffResponse> {
    const diff = parseDiff(await this.diffText(session, options));
    const token = await this.access.tokenFor(session.userId);
    const counted = diff.files.filter(file => file.status !== 'added' && !file.isBinary);
    const contents = await this.mirrors.readFiles(
      session.owner,
      session.repo,
      token,
      session.baseSha,
      counted.map(file => file.oldPath || file.newPath),
    );
    for (const file of counted) {
      const content = contents.get(file.oldPath || file.newPath);
      if (content != null) {
        file.oldFileLineCount = splitLines(content).length;
      }
    }
    let suppressed: Suppressed | null = null;
    if (options.ignoreWhitespace && options.path === undefined) {
      const unfiltered = parseShortStat(
        await this.mirrors.shortStat(session.owner, session.repo, token, session.baseSha, session.headSha),
      );
      suppressed = {
        files: Math.max(0, unfiltered.files - diff.stats.filesChanged),
        lines: Math.max(0, unfiltered.lines - diff.stats.totalAdditions - diff.stats.totalDeletions),
      };
    }
    return { ...diff, suppressed };
  }

  async readFile(session: ReviewSessionRecord, side: 'old' | 'new', path: string): Promise<string | null> {
    if (!isSafeRepoPath(path)) {
      return null;
    }
    const token = await this.access.tokenFor(session.userId);
    return this.mirrors.readFile(session.owner, session.repo, token, side === 'old' ? session.baseSha : session.headSha, path);
  }

  /** The project's own review rules, as they are at the reviewed head. */
  async standards(session: ReviewSessionRecord): Promise<Standards> {
    const raw = await this.readFile(session, 'new', REPO_CONFIG_FILE);
    const review = raw ? parseRepoConfig(raw).review : undefined;
    let standards: Standards['standards'] = null;
    if (review?.standards) {
      const content = await this.readFile(session, 'new', review.standards);
      if (content != null) {
        standards = { path: review.standards, content };
      }
    }
    return { severities: review?.severities ?? DEFAULT_SEVERITIES, standards };
  }

  /**
   * Refused where the mistake is made: a thread on a file outside the diff renders nowhere, so the
   * finding would look written and never be seen.
   */
  async assertInDiff(session: ReviewSessionRecord, filePath: string, side: 'old' | 'new'): Promise<void> {
    const files = await this.changedFiles(session);
    const paths = files.map(file => (side === 'old' ? file.oldPath : file.newPath));
    if (!paths.includes(filePath)) {
      const listed = files.slice(0, 20).map(file => `  ${file.newPath}`).join('\n');
      const more = files.length > 20 ? `\n  … and ${files.length - 20} more` : '';
      throw new ServiceError(
        `File "${filePath}" is not on the ${side} side of this session's diff. The diff has ${files.length} file(s):\n${listed}${more}`,
      );
    }
  }

  threadsForSession(session: ReviewSessionRecord): CommentThread[] {
    return this.reviews.threadsForSession(session.userId, session.id);
  }
}

function sessionMode(input: CreateSessionInput): 'pr' | 'shas' | 'patch' {
  const hasPr = input.pr !== undefined;
  const hasHead = input.head !== undefined;
  const hasPatch = input.patch !== undefined;
  if (hasPr && !hasHead && !hasPatch && input.base === undefined) {
    if (!Number.isInteger(input.pr) || input.pr! < 1) {
      throw new ServiceError('pr must be a positive integer');
    }
    return 'pr';
  }
  if (!hasPr && input.base !== undefined && hasHead !== hasPatch) {
    if (!isSha(input.base)) {
      throw new ServiceError('base must be a full 40-character commit sha');
    }
    if (hasHead) {
      if (!isSha(input.head!)) {
        throw new ServiceError('head must be a full 40-character commit sha');
      }
      return 'shas';
    }
    if (!input.patch!.trim()) {
      throw new ServiceError('patch is empty');
    }
    if (Buffer.byteLength(input.patch!) > MAX_PATCH_BYTES) {
      throw new ServiceError(`patch is larger than ${MAX_PATCH_BYTES / 1024 / 1024} MB`);
    }
    return 'patch';
  }
  throw new ServiceError('Give exactly one of: pr; base and head; base and patch');
}
