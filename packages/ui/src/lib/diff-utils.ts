import type { DiffFile, DiffHunk } from '@diffity/parser';
import type { CommentSide } from '../components/comments/types';

export type ViewMode = 'unified' | 'split';

export function getFilePath(file: DiffFile): string {
  if (file.status === 'deleted') {
    return file.oldPath;
  }
  return file.newPath;
}

export function getLineBg(type: string): string {
  switch (type) {
    case 'add':
      return 'bg-diff-add-bg';
    case 'delete':
      return 'bg-diff-del-bg';
    default:
      return 'bg-bg';
  }
}

const LOCK_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-lock.yml',
  'bun.lock',
  'bun.lockb',
  'yarn.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'poetry.lock',
  'Pipfile.lock',
  'go.sum',
  'flake.lock',
  'pubspec.lock',
  'Podfile.lock',
  'packages.lock.json',
  'project.assets.json',
  'paket.lock',
  'pnpm-workspace.yaml',
  'shrinkwrap.yaml',
]);

const GENERATED_EXTENSIONS = [
  '.min.js',
  '.min.css',
  '.min.mjs',
  '.bundle.js',
  '.bundle.css',
  '.chunk.js',
  '.chunk.css',
  '.generated.ts',
  '.generated.js',
  '.g.dart',
  '.freezed.dart',
  '.pb.go',
  '.pb.ts',
  '.pb.js',
];

const GENERATED_PATTERNS = [
  /\.d\.ts$/,
  /\.map$/,
  /\.snap$/,
  /dist\//,
  /build\//,
  /generated\//,
  /__generated__\//,
  /\.lock$/,
];

const AUTO_COLLAPSE_LINE_THRESHOLD = 1000;

function getTotalLineCount(file: DiffFile): number {
  let count = 0;
  for (const hunk of file.hunks) {
    count += hunk.lines.length;
  }
  return count;
}

export function isAutoCollapsible(file: DiffFile): boolean {
  if (file.status === 'deleted' || file.status === 'renamed') {
    return true;
  }

  if (getTotalLineCount(file) >= AUTO_COLLAPSE_LINE_THRESHOLD) {
    return true;
  }

  const path = getFilePath(file);
  const fileName = path.split('/').pop() || '';

  if (LOCK_FILES.has(fileName)) {
    return true;
  }

  const lowerPath = path.toLowerCase();
  for (const ext of GENERATED_EXTENSIONS) {
    if (lowerPath.endsWith(ext)) {
      return true;
    }
  }

  for (const pattern of GENERATED_PATTERNS) {
    if (pattern.test(path)) {
      return true;
    }
  }

  return false;
}

export function getAutoCollapsedPaths(files: DiffFile[]): Set<string> {
  const paths = new Set<string>();
  for (const file of files) {
    if (isAutoCollapsible(file)) {
      paths.add(getFilePath(file));
    }
  }
  return paths;
}

export function extractLinesFromDiff(
  hunks: DiffHunk[],
  side: CommentSide,
  startLine: number,
  endLine: number,
): string {
  const result: string[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const lineNum = side === 'old' ? line.oldLineNumber : line.newLineNumber;
      if (lineNum === null || lineNum < startLine || lineNum > endLine) {
        continue;
      }
      if (side === 'old' && (line.type === 'delete' || line.type === 'context')) {
        result.push(line.content);
      } else if (side === 'new' && (line.type === 'add' || line.type === 'context')) {
        result.push(line.content);
      }
    }
  }
  return result.join('\n');
}

export function extractLinesFromExpandedLines(
  lines: { type: string; content: string; oldLineNumber: number | null; newLineNumber: number | null }[],
  side: CommentSide,
  startLine: number,
  endLine: number,
): string {
  const result: string[] = [];
  for (const line of lines) {
    const lineNum = side === 'old' ? line.oldLineNumber : line.newLineNumber;
    if (lineNum === null || lineNum < startLine || lineNum > endLine) {
      continue;
    }
    result.push(line.content);
  }
  return result.join('\n');
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'added':
      return 'bg-added/15 text-added';
    case 'deleted':
      return 'bg-deleted/15 text-deleted';
    case 'renamed':
      return 'bg-renamed/15 text-renamed';
    default:
      return 'bg-modified/15 text-modified';
  }
}
