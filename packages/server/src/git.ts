import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export class GitError extends Error {
  constructor(message: string, readonly exitCode: number | null, readonly stderr: string) {
    super(message);
  }
}

export interface GitOptions {
  gitDir?: string;
  input?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The operator's own git config — `insteadOf` rewrites, credential helpers, colour — would change
 * what a mirror fetches and with whose credentials, so it is shut out of every call.
 */
const ISOLATED_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
};

export async function runGit(args: string[], options: GitOptions = {}): Promise<string> {
  return (await runGitBuffer(args, options)).toString('utf8');
}

export function runGitBuffer(args: string[], options: GitOptions = {}): Promise<Buffer> {
  const fullArgs = options.gitDir ? ['--git-dir', options.gitDir, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn('git', fullArgs, {
      env: { ...process.env, ...ISOLATED_ENV, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill();
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      const stderr = Buffer.concat(err).toString('utf8');
      if (size > MAX_OUTPUT_BYTES) {
        reject(new GitError(`git ${args[0]} produced more than ${MAX_OUTPUT_BYTES} bytes`, code, stderr));
        return;
      }
      if (code !== 0) {
        reject(new GitError(`git ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`, code, stderr));
        return;
      }
      resolve(Buffer.concat(out));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}

/** Runs works one at a time in arrival order; one failing does not break the chain. */
function serializer(): <T>(work: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return work => {
    const run = chain.then(work, work);
    chain = run.catch(() => {});
    return run;
  };
}

/** Same flags as the CLI's diffs, so the parser sees the format it was written for. */
const DIFF_FORMAT_ARGS = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

export function isSha(value: string): boolean {
  return SHA_PATTERN.test(value);
}

export function isRepoName(value: string): boolean {
  return NAME_PATTERN.test(value) && value !== '.' && value !== '..';
}

/**
 * A repository-relative path as the diff names it. Rejected rather than normalised: nothing in a
 * review has a reason to send an absolute path or climb out with `..`.
 */
export function isSafeRepoPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\0') || path.includes('\\')) {
    return false;
  }
  return path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

export type RemoteUrlBuilder = (owner: string, repo: string) => string;

export const githubRemoteUrl: RemoteUrlBuilder = (owner, repo) => `https://github.com/${owner}/${repo}.git`;

/**
 * Passed through the environment rather than `-c`, so the token is not in the argument list that
 * `ps` shows every user on the host, and never written into the mirror's config. Git hands
 * `GIT_CONFIG_*` on to the fetches a partial clone makes behind the scenes.
 */
function authEnv(token: string | null): Record<string, string> {
  if (!token) {
    return {};
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

export interface NameStatus {
  status: string;
  oldPath: string;
  newPath: string;
}

export function parseNameStatus(raw: string): NameStatus[] {
  const entries: NameStatus[] = [];
  for (const line of raw.split('\n')) {
    if (!line) {
      continue;
    }
    const [status, first, second] = line.split('\t');
    if (!status || !first) {
      continue;
    }
    entries.push({ status, oldPath: first, newPath: second ?? first });
  }
  return entries;
}

/**
 * Bare, blob-less mirrors of GitHub repositories, one per repository, shared by every user. Access
 * is checked against GitHub before a mirror is touched; the mirror itself only holds what has been
 * fetched with some permitted user's token.
 */
export class Mirrors {
  private readonly locks = new Map<string, <T>(work: () => Promise<T>) => Promise<T>>();

  constructor(private readonly dataDir: string, private readonly remoteUrl: RemoteUrlBuilder = githubRemoteUrl) {}

  pathFor(owner: string, repo: string): string {
    if (!isRepoName(owner) || !isRepoName(repo)) {
      throw new Error(`Not a repository name: ${owner}/${repo}`);
    }
    return join(this.dataDir, 'mirrors', owner.toLowerCase(), `${repo.toLowerCase()}.git`);
  }

  private lock(key: string): <T>(work: () => Promise<T>) => Promise<T> {
    let run = this.locks.get(key);
    if (!run) {
      run = serializer();
      this.locks.set(key, run);
    }
    return run;
  }

  private withRepo<T>(owner: string, repo: string, work: (gitDir: string) => Promise<T>): Promise<T> {
    const gitDir = this.pathFor(owner, repo);
    return this.lock(gitDir)(() => work(gitDir));
  }

  private async ensureCloned(owner: string, repo: string, gitDir: string, token: string | null): Promise<void> {
    if (existsSync(join(gitDir, 'HEAD'))) {
      return;
    }
    await mkdir(dirname(gitDir), { recursive: true });
    // Cloned beside the target and moved into place, so a failed clone leaves nothing that
    // looks like a mirror.
    const staging = `${gitDir}.tmp-${randomUUID()}`;
    try {
      await runGit(['clone', '--bare', '--filter=blob:none', '--no-tags', this.remoteUrl(owner, repo), staging], {
        env: authEnv(token),
        timeoutMs: 30 * 60 * 1000,
      });
      // The shas a session needs are pinned by refs, but a gc could still drop what a review is
      // looking at before it is pinned.
      await runGit(['config', 'gc.auto', '0'], { gitDir: staging });
      await runGit(['config', 'maintenance.auto', 'false'], { gitDir: staging });
      await rename(staging, gitDir);
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      throw err;
    }
  }

  private async hasObject(gitDir: string, spec: string): Promise<boolean> {
    try {
      await runGit(['cat-file', '-e', spec], { gitDir });
      return true;
    } catch {
      return false;
    }
  }

  private async pin(gitDir: string, sha: string): Promise<void> {
    await runGit(['update-ref', `refs/diffity/keep/${sha}`, sha], { gitDir });
  }

  /** Makes each commit present, fetching the ones that are not, and pins them against gc. */
  fetchCommits(owner: string, repo: string, token: string | null, shas: string[]): Promise<void> {
    return this.withRepo(owner, repo, async gitDir => {
      await this.ensureCloned(owner, repo, gitDir, token);
      for (const sha of shas) {
        if (!isSha(sha)) {
          throw new Error(`Not a full commit sha: ${sha}`);
        }
        if (!(await this.hasObject(gitDir, `${sha}^{commit}`))) {
          await runGit(['fetch', '--filter=blob:none', '--no-tags', 'origin', sha], {
            gitDir,
            env: authEnv(token),
          });
        }
        if (!(await this.hasObject(gitDir, `${sha}^{commit}`))) {
          throw new Error(`Commit ${sha} is not in ${owner}/${repo}`);
        }
        await this.pin(gitDir, sha);
      }
    });
  }

  /** The pull request's head as GitHub has it now, fetched and pinned. */
  fetchPullHead(owner: string, repo: string, token: string | null, prNumber: number): Promise<string> {
    return this.withRepo(owner, repo, async gitDir => {
      await this.ensureCloned(owner, repo, gitDir, token);
      const ref = `refs/diffity/pull/${prNumber}`;
      await runGit(['fetch', '--filter=blob:none', '--no-tags', 'origin', `+refs/pull/${prNumber}/head:${ref}`], {
        gitDir,
        env: authEnv(token),
      });
      const sha = (await runGit(['rev-parse', '--verify', `${ref}^{commit}`], { gitDir })).trim();
      await this.pin(gitDir, sha);
      return sha;
    });
  }

  mergeBase(owner: string, repo: string, token: string | null, a: string, b: string): Promise<string> {
    return this.withRepo(owner, repo, async gitDir =>
      (await runGit(['merge-base', a, b], { gitDir, env: authEnv(token) })).trim(),
    );
  }

  /**
   * The tree a patch makes of the base commit, built in a throwaway index so the mirror's own
   * state is never touched. Its sha stands in for a head commit that does not exist.
   */
  applyPatch(owner: string, repo: string, token: string | null, base: string, patch: string): Promise<string> {
    return this.withRepo(owner, repo, async gitDir => {
      const indexFile = join(this.dataDir, 'tmp', `${randomUUID()}.index`);
      await mkdir(dirname(indexFile), { recursive: true });
      const env = { ...authEnv(token), GIT_INDEX_FILE: indexFile };
      try {
        await runGit(['read-tree', base], { gitDir, env });
        try {
          await runGit(['apply', '--cached', '--whitespace=nowarn', '-'], { gitDir, env, input: patch });
        } catch (err) {
          const detail = err instanceof GitError ? err.stderr.trim() : String(err);
          throw new Error(`The patch does not apply to ${base.slice(0, 12)}: ${detail}`);
        }
        const tree = (await runGit(['write-tree'], { gitDir, env })).trim();
        await runGit(['update-ref', `refs/diffity/keep/tree-${tree}`, tree], { gitDir });
        return tree;
      } finally {
        await rm(indexFile, { force: true });
      }
    });
  }

  diff(
    owner: string,
    repo: string,
    token: string | null,
    base: string,
    head: string,
    options: { ignoreWhitespace?: boolean; path?: string } = {},
  ): Promise<string> {
    return this.withRepo(owner, repo, gitDir =>
      runGit(
        [
          '--literal-pathspecs',
          'diff',
          ...DIFF_FORMAT_ARGS,
          ...(options.ignoreWhitespace ? ['-w'] : []),
          base,
          head,
          ...(options.path ? ['--', options.path] : []),
        ],
        { gitDir, env: authEnv(token) },
      ),
    );
  }

  shortStat(owner: string, repo: string, token: string | null, base: string, head: string): Promise<string> {
    return this.withRepo(owner, repo, gitDir =>
      runGit(['diff', '--shortstat', base, head], { gitDir, env: authEnv(token) }),
    );
  }

  nameStatus(owner: string, repo: string, token: string | null, base: string, head: string): Promise<NameStatus[]> {
    return this.withRepo(owner, repo, async gitDir =>
      parseNameStatus(await runGit(['diff', '--name-status', base, head], { gitDir, env: authEnv(token) })),
    );
  }

  renames(owner: string, repo: string, token: string | null, from: string, to: string): Promise<NameStatus[]> {
    return this.withRepo(owner, repo, async gitDir =>
      parseNameStatus(
        await runGit(['diff', '-M', '--name-status', '--diff-filter=R', from, to], { gitDir, env: authEnv(token) }),
      ),
    );
  }

  /** Many files in one git call; a path missing at that revision maps to null. */
  readFiles(owner: string, repo: string, token: string | null, rev: string, paths: string[]): Promise<Map<string, string | null>> {
    const wanted = paths.filter(isSafeRepoPath);
    const result = new Map<string, string | null>(paths.map(path => [path, null]));
    if (wanted.length === 0) {
      return Promise.resolve(result);
    }
    return this.withRepo(owner, repo, async gitDir => {
      const raw = await runGitBuffer(['cat-file', '--batch'], {
        gitDir,
        env: authEnv(token),
        input: wanted.map(path => `${rev}:${path}`).join('\n') + '\n',
      });
      let offset = 0;
      for (const path of wanted) {
        const newline = raw.indexOf(0x0a, offset);
        if (newline === -1) {
          break;
        }
        const header = raw.subarray(offset, newline).toString('utf8');
        offset = newline + 1;
        const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
        if (!match) {
          continue;
        }
        const size = Number(match[2]);
        if (match[1] === 'blob') {
          result.set(path, raw.subarray(offset, offset + size).toString('utf8'));
        }
        offset += size + 1;
      }
      return result;
    });
  }

  /** Null when the path does not exist at that revision. */
  readFile(owner: string, repo: string, token: string | null, rev: string, path: string): Promise<string | null> {
    if (!isSafeRepoPath(path)) {
      return Promise.resolve(null);
    }
    return this.withRepo(owner, repo, async gitDir => {
      try {
        return await runGit(['cat-file', 'blob', `${rev}:${path}`], { gitDir, env: authEnv(token) });
      } catch (err) {
        if (err instanceof GitError) {
          return null;
        }
        throw err;
      }
    });
  }
}
