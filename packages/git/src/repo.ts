import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { sep } from 'node:path';
import { homedir } from 'node:os';
import { exec, git } from './exec.js';
import { readRepoConfig, resolveDataDir } from './config.js';
import { WORKING_TREE_REFS } from './diff.js';
import type { RepoInfo } from './types.js';

export function isGitRepo(): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function getRepoRoot(): string {
  return exec('git rev-parse --show-toplevel');
}

export function getRepoName(): string {
  const root = getRepoRoot();
  return root.split('/').pop() || root;
}

export function getCurrentBranch(): string {
  try {
    return exec('git rev-parse --abbrev-ref HEAD');
  } catch {
    return 'HEAD';
  }
}

export function getRepoInfo(): RepoInfo {
  return {
    name: getRepoName(),
    branch: getCurrentBranch(),
    root: getRepoRoot(),
  };
}

export function getHeadHash(): string {
  return exec('git rev-parse HEAD');
}

/** The commit a ref names, so a moving name like `HEAD` or `main` is pinned to what it meant. */
export function getCommitHash(ref: string): string {
  return git(['rev-parse', '--verify', `${ref}^{commit}`]);
}

export function getDiffityDirPath(): string {
  const repoRoot = getRepoRoot();
  return resolveDataDir({
    repoRoot,
    homeDir: homedir(),
    envDir: process.env.DIFFITY_DATA_DIR,
    configDir: readRepoConfig(repoRoot).dataDir,
  });
}

export function getDiffityDir(): string {
  const dir = getDiffityDirPath();
  // Review notes quote the code under review, so they are not readable by other accounts.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * True when the data directory sits inside the working tree without git ignoring it, which
 * would otherwise show review notes as untracked changes in the very diff being reviewed.
 */
export function isDataDirUntracked(): boolean {
  const dir = getDiffityDirPath();
  const repoRoot = getRepoRoot();

  if (!dir.startsWith(repoRoot + sep)) {
    return false;
  }

  try {
    execFileSync('git', ['check-ignore', '--quiet', dir], { stdio: 'pipe' });
    return false;
  } catch {
    return true;
  }
}

export function isValidGitRef(ref: string): boolean {
  if (ref.includes('...')) {
    const parts = ref.split('...');
    return parts.every((p) => isValidGitRef(p));
  }

  if (ref.includes('..')) {
    const parts = ref.split('..');
    return parts.every((p) => isValidGitRef(p));
  }

  try {
    execFileSync('git', ['rev-parse', '--verify', ref], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export interface RefCapabilities {
  reviews: boolean;
  revert: boolean;
  staleness: boolean;
}

export function getRefCapabilities(ref?: string): RefCapabilities {
  if (!ref) {
    return { reviews: true, revert: false, staleness: false };
  }
  const isWorkingTree = WORKING_TREE_REFS.has(ref);
  return {
    reviews: true,
    revert: isWorkingTree,
    staleness: true,
  };
}
