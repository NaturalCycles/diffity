/**
 * The file the reader was last looking at, so a page rebuilt underneath them — a server restart, a
 * failed poll — puts them back rather than at the top of the diff. Kept per checkout and diff,
 * because a position from one diff means nothing in another.
 */
function key(repoRoot: string, ref: string): string {
  return `diffity:reading:${repoRoot}:${ref}`;
}

export function readReadingPosition(storage: Storage, repoRoot: string, ref: string): string | null {
  return storage.getItem(key(repoRoot, ref));
}

export function writeReadingPosition(storage: Storage, repoRoot: string, ref: string, filePath: string): void {
  storage.setItem(key(repoRoot, ref), filePath);
}

export function clearReadingPosition(storage: Storage, repoRoot: string, ref: string): void {
  storage.removeItem(key(repoRoot, ref));
}
