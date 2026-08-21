import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DiffFile, DiffHunk, DiffLine } from '@diffity/parser';
import { FileBlock } from '../src/components/diff/file-block';
import type { CommentActions } from '../src/hooks/use-comment-actions';

function line(type: DiffLine['type'], content: string, num: number): DiffLine {
  return {
    type,
    content,
    oldLineNumber: type === 'add' ? null : num,
    newLineNumber: type === 'delete' ? null : num,
  };
}

function hunkAt(newStart: number, lines: DiffLine[]): DiffHunk {
  return {
    header: `@@ -${newStart},${lines.length} +${newStart},${lines.length} @@`,
    oldStart: newStart,
    oldCount: lines.length,
    newStart,
    newCount: lines.length,
    lines,
  };
}

function file(path: string, hunks: DiffHunk[]): DiffFile {
  return {
    oldPath: path,
    newPath: path,
    status: 'modified',
    hunks,
    additions: 1,
    deletions: 0,
    isBinary: false,
  };
}

// The component takes a bag of callbacks it never invokes during a plain render.
const commentActions = {} as CommentActions;

function renderFileBlock(target: DiffFile, focusRanges?: { startLine: number; endLine: number }[]) {
  // FileBlock expands context through a query, so it needs a client even when nothing fetches.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={queryClient}>
    <FileBlock
      file={target}
      viewMode="unified"
      collapsed={false}
      onToggleCollapse={vi.fn()}
      reviewed={false}
      onReviewedChange={vi.fn()}
      threads={[]}
      commentsEnabled={false}
      commentActions={commentActions}
      onAddThread={vi.fn()}
      pendingSelection={null}
      onPendingSelectionChange={vi.fn()}
      focusRanges={focusRanges}
    />
    </QueryClientProvider>,
  );
}

function tbodyClasses(): string[] {
  return Array.from(document.querySelectorAll('tbody')).map(body => body.className);
}

afterEach(cleanup);

describe('FileBlock attention', () => {
  const importsHunk = hunkAt(1, [line('add', "import { a } from 'a';", 1)]);
  const workHunk = hunkAt(40, [line('add', 'doWork();', 40)]);

  it('renders at all', () => {
    expect(() => renderFileBlock(file('src/a.ts', [workHunk]))).not.toThrow();
    expect(document.querySelectorAll('tbody').length).toBeGreaterThan(0);
  });

  it('dims an imports-only hunk and says why', () => {
    renderFileBlock(file('src/a.ts', [importsHunk]));

    expect(tbodyClasses().some(c => c.includes('opacity-45'))).toBe(true);
    const titled = Array.from(document.querySelectorAll('tbody[title]'));
    expect(titled.length).toBeGreaterThan(0);
    expect(titled[0].getAttribute('title')).toBe('Dimmed: imports only');
  });

  it('leaves real work at full attention', () => {
    renderFileBlock(file('src/a.ts', [workHunk]));

    expect(tbodyClasses().some(c => c.includes('opacity-45'))).toBe(false);
    expect(document.querySelectorAll('tbody[title]').length).toBe(0);
  });

  it('does not dim whitespace in a file where indentation is syntax', () => {
    const reindent = hunkAt(1, [line('delete', '  key: value', 1), line('add', '    key: value', 1)]);
    renderFileBlock(file('.github/workflows/ci.yml', [reindent]));

    expect(tbodyClasses().some(c => c.includes('opacity-45'))).toBe(false);
  });

  it('highlights a hunk the walkthrough points at, in preference to dimming it', () => {
    renderFileBlock(file('src/a.ts', [importsHunk]), [{ startLine: 1, endLine: 1 }]);

    expect(tbodyClasses().some(c => c.includes('bg-accent/5'))).toBe(true);
    expect(tbodyClasses().some(c => c.includes('opacity-45'))).toBe(false);
    expect(document.querySelector('tbody[title]')?.getAttribute('title')).toBe(
      'The walkthrough points here',
    );
  });

  it('highlights only the hunk in range', () => {
    renderFileBlock(file('src/a.ts', [importsHunk, workHunk]), [{ startLine: 40, endLine: 40 }]);

    const focused = tbodyClasses().filter(c => c.includes('bg-accent/5'));
    const dimmed = tbodyClasses().filter(c => c.includes('opacity-45'));
    expect(focused.length).toBeGreaterThan(0);
    expect(dimmed.length).toBeGreaterThan(0);
  });
});
