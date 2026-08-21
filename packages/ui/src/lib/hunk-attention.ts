import type { DiffFile, DiffHunk, DiffLine } from '@diffity/parser';
import { isAutoCollapsible } from './diff-utils';

/**
 * Why a hunk was judged mechanical. Every reason here is decided by a rule, never by a model:
 * dimming asserts that something needs less attention, which is the one claim a review tool
 * should only make when it can show its reasoning.
 */
export type MechanicalReason = 'generated' | 'whitespace' | 'imports';

export const MECHANICAL_LABELS: Record<MechanicalReason, string> = {
  generated: 'generated',
  whitespace: 'whitespace only',
  imports: 'imports only',
};

// Indentation is syntax in these, so a whitespace change is a real change and must not be dimmed.
const INDENTATION_SENSITIVE = [
  '.py',
  '.pyi',
  '.yml',
  '.yaml',
  '.md',
  '.markdown',
  '.mk',
  '.nim',
  '.hs',
  '.sass',
  '.styl',
  '.pug',
  '.haml',
  '.slim',
  '.coffee',
  '.elm',
];

const IMPORT_PATTERNS = [
  /^\s*import\b/,
  /^\s*export\s[^=]*\bfrom\b/,
  /^\s*(?:const|let|var)\s+.*=\s*require\s*\(/,
  /^\s*from\s+\S+\s+import\b/,
  /^\s*use\s+[\w:{}*, ]+;\s*$/,
  /^\s*#include\b/,
  /^\s*require(?:_relative)?\s+['"]/,
  /^\s*package\s+\S+\s*;?\s*$/,
];

export function isIndentationSensitive(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.endsWith('makefile') || lower.includes('makefile.')) {
    return true;
  }
  return INDENTATION_SENSITIVE.some(ext => lower.endsWith(ext));
}

function changedLines(hunk: DiffHunk): DiffLine[] {
  return hunk.lines.filter(line => line.type === 'add' || line.type === 'delete');
}

function withoutWhitespace(content: string): string {
  return content.replace(/\s+/g, '');
}

/**
 * True when the added and removed lines are the same lines with different whitespace. A blank
 * line that appeared or disappeared is a real change to the file's shape, so it does not count.
 */
export function isWhitespaceOnlyHunk(hunk: DiffHunk): boolean {
  const changed = changedLines(hunk);
  if (changed.length === 0) {
    return false;
  }

  // Compared in order, not as a multiset: the same lines coming back in a different order is a
  // change, and sorting first would call it formatting.
  const added = changed.filter(line => line.type === 'add').map(line => withoutWhitespace(line.content));
  const removed = changed.filter(line => line.type === 'delete').map(line => withoutWhitespace(line.content));

  return (
    added.length > 0 &&
    added.length === removed.length &&
    added.every((line, index) => line === removed[index])
  );
}

/**
 * True when every line the hunk touches is an import. A linter will catch an unused or unsorted
 * import, but not a wrong one, so this dims rather than hides.
 */
export function isImportOnlyHunk(hunk: DiffHunk): boolean {
  const changed = changedLines(hunk);
  if (changed.length === 0) {
    return false;
  }

  let sawImport = false;
  for (const line of changed) {
    if (line.content.trim() === '') {
      continue;
    }
    if (!IMPORT_PATTERNS.some(pattern => pattern.test(line.content))) {
      return false;
    }
    sawImport = true;
  }

  return sawImport;
}

export function classifyHunk(file: DiffFile, hunk: DiffHunk): MechanicalReason | null {
  if (isAutoCollapsible(file)) {
    return 'generated';
  }

  const path = file.status === 'deleted' ? file.oldPath : file.newPath;

  if (!isIndentationSensitive(path) && isWhitespaceOnlyHunk(hunk)) {
    return 'whitespace';
  }

  if (isImportOnlyHunk(hunk)) {
    return 'imports';
  }

  return null;
}

export interface FocusRange {
  startLine: number;
  endLine: number;
}

/**
 * Whether a hunk covers any of the lines the walkthrough points at. Compared on the new side,
 * which is where a walkthrough step's lines are recorded.
 */
export function hunkIntersectsRanges(hunk: DiffHunk, ranges: FocusRange[] | undefined): boolean {
  if (!ranges || ranges.length === 0) {
    return false;
  }

  const from = hunk.newStart;
  const to = hunk.newStart + hunk.newCount - 1;

  return ranges.some(range => range.startLine <= to && range.endLine >= from);
}
