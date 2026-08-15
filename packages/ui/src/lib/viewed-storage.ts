import type { DiffFile } from '@diffity/parser';
import { getFilePath } from './diff-utils';

const STORAGE_KEY = 'diffity-viewed';
const STORAGE_VERSION = 1;
const MAX_ENTRIES = 10;

/** Map of file path -> fingerprint of the file's diff at the time it was marked viewed. */
export type ViewedFiles = Record<string, string>;

interface ViewedEntry {
  updatedAt: number;
  /**
   * Monotonic write counter used to order entries for eviction. Date.now() is too coarse —
   * several writes can land in the same millisecond and tie, which makes eviction arbitrary.
   */
  seq: number;
  files: ViewedFiles;
}

interface ViewedStore {
  version: number;
  seq: number;
  entries: Record<string, ViewedEntry>;
}

function emptyStore(): ViewedStore {
  return { version: STORAGE_VERSION, seq: 0, entries: {} };
}

export function buildEntryKey(repoRoot: string, ref: string): string {
  return `${repoRoot}|${ref}`;
}

/**
 * Fingerprints a file's diff so we can tell whether it changed since it was marked viewed.
 *
 * Two files with the same fingerprint are treated as "the same change", and a viewed mark
 * survives. A different fingerprint drops the mark and the file expands again.
 *
 * Deliberately excluded: context lines, hunk headers, and line numbers, so an unrelated edit
 * elsewhere in the file doesn't unmark a hunk you already reviewed. Content is trimmed so
 * toggling the hide-whitespace filter doesn't churn every mark.
 */
export function fingerprintFile(file: DiffFile): string {
  const parts: string[] = [file.status, file.oldPath, file.newPath];

  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'context') {
        continue;
      }
      parts.push(`${line.type}:${line.content.trim()}`);
    }
  }

  return hashString(parts.join('\n'));
}

/** FNV-1a. Non-cryptographic and synchronous, so restore happens in a single pass. */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function fingerprintFiles(files: DiffFile[]): ViewedFiles {
  const fingerprints: ViewedFiles = {};

  for (const file of files) {
    fingerprints[getFilePath(file)] = fingerprintFile(file);
  }

  return fingerprints;
}

/** Keeps a stored viewed mark only when the file's fingerprint still matches. */
export function reconcileViewed(
  stored: ViewedFiles,
  current: ViewedFiles,
): Set<string> {
  const viewed = new Set<string>();

  for (const [path, fingerprint] of Object.entries(stored)) {
    if (current[path] === fingerprint) {
      viewed.add(path);
    }
  }

  return viewed;
}

/** Narrows a full fingerprint map down to the paths that are currently marked viewed. */
export function pickFingerprints(
  fingerprints: ViewedFiles,
  paths: Set<string>,
): ViewedFiles {
  const picked: ViewedFiles = {};

  for (const path of paths) {
    if (fingerprints[path] !== undefined) {
      picked[path] = fingerprints[path];
    }
  }

  return picked;
}

function readStore(): ViewedStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return emptyStore();
    }

    const parsed = JSON.parse(raw) as ViewedStore;
    if (
      parsed?.version !== STORAGE_VERSION ||
      typeof parsed.entries !== 'object'
    ) {
      return emptyStore();
    }

    return { ...parsed, seq: parsed.seq ?? 0 };
  } catch {
    return emptyStore();
  }
}

/** Drops the least recently used entries so the store can't grow without bound. */
export function evictOldest(
  entries: Record<string, ViewedEntry>,
  max = MAX_ENTRIES,
): Record<string, ViewedEntry> {
  const keys = Object.keys(entries);
  if (keys.length <= max) {
    return entries;
  }

  const kept = keys
    .sort((a, b) => entries[b].seq - entries[a].seq)
    .slice(0, max);

  const next: Record<string, ViewedEntry> = {};
  for (const key of kept) {
    next[key] = entries[key];
  }

  return next;
}

export function loadViewedFiles(repoRoot: string, ref: string): ViewedFiles {
  return readStore().entries[buildEntryKey(repoRoot, ref)]?.files ?? {};
}

export function saveViewedFiles(
  repoRoot: string,
  ref: string,
  files: ViewedFiles,
): void {
  try {
    const store = readStore();
    const key = buildEntryKey(repoRoot, ref);

    if (Object.keys(files).length === 0) {
      delete store.entries[key];
    } else {
      store.seq += 1;
      store.entries[key] = { updatedAt: Date.now(), seq: store.seq, files };
    }

    store.entries = evictOldest(store.entries);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage full, disabled, or unavailable — viewed state just won't persist.
  }
}
