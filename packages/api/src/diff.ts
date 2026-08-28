import type { DiffFile, ParsedDiff } from '@diffity/parser';

/**
 * How much whitespace hiding removed. A filtered diff renders fewer files and lines than the forge
 * shows, so the page has to be able to name the difference.
 */
export interface Suppressed {
  files: number;
  lines: number;
}

/** What `/api/diff` answers. */
export interface DiffResponse extends ParsedDiff {
  suppressed: Suppressed | null;
}

/** Null rather than an empty diff: the file may no longer differ at all. */
export interface DiffFileResponse {
  file: DiffFile | null;
}

export interface DiffFingerprint {
  fingerprint: string;
  /** Each file against its own churn, so the page can say which ones moved. */
  files: Record<string, string>;
}

export interface FileContentResponse {
  path: string;
  content: string[];
}

export interface TreeEntry {
  type: 'blob' | 'tree';
  path: string;
  name: string;
}

export interface TreePathsResponse {
  paths: string[];
}

export interface TreeEntriesResponse {
  entries: TreeEntry[];
}

export interface TreeFingerprintResponse {
  fingerprint: string;
}
