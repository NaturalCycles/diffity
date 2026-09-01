import { gitUntrimmed } from './exec.js';

/**
 * Every path `git status` reports as changed — staged, unstaged or untracked. A rename or copy
 * contributes both of its endpoints. NUL framing so paths with spaces, quotes or newlines come
 * through verbatim.
 */
export function dirtyPaths(): string[] {
  const fields = gitUntrimmed(['status', '--porcelain=v1', '-z']).split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i].slice(0, 2);
    paths.push(fields[i].slice(3));
    // With -z the pre-rename path is its own NUL-separated field after the entry.
    if (status.includes('R') || status.includes('C')) {
      i++;
      paths.push(fields[i]);
    }
  }
  return paths;
}
