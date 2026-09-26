import type { ParsedDiff } from '@diffity/parser';

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

export interface FileContentResponse {
  path: string;
  content: string[];
}
