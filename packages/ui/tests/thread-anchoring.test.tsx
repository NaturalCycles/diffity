import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DiffFile, DiffHunk, DiffLine } from '@diffity/parser';
import { FileBlock } from '../src/components/diff/file-block';
import type { CommentActions } from '../src/hooks/use-comment-actions';
import type { CommentThread } from '../src/components/comments/types';

function line(type: DiffLine['type'], content: string, num: number): DiffLine {
  return {
    type,
    content,
    oldLineNumber: type === 'add' ? null : num,
    newLineNumber: type === 'delete' ? null : num,
  };
}

// A two-line file, as the diff renders it.
const hunk: DiffHunk = {
  header: '@@ -1,2 +1,2 @@',
  oldStart: 1,
  oldCount: 2,
  newStart: 1,
  newCount: 2,
  lines: [line('context', 'const a = 1;', 1), line('add', 'const b = 2;', 2)],
};

const file: DiffFile = {
  oldPath: 'src/a.ts',
  newPath: 'src/a.ts',
  status: 'modified',
  hunks: [hunk],
  additions: 1,
  deletions: 0,
  isBinary: false,
};

function thread(startLine: number, endLine: number, body: string): CommentThread {
  return {
    id: `t-${startLine}-${endLine}`,
    filePath: 'src/a.ts',
    side: 'new',
    startLine,
    endLine,
    status: 'open',
    comments: [{ id: `c-${startLine}`, author: { name: 'Agent', type: 'agent' }, body, createdAt: '' }],
  };
}

function renderWith(threads: CommentThread[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <FileBlock
        file={file}
        viewMode="unified"
        collapsed={false}
        onToggleCollapse={vi.fn()}
        reviewed={false}
        onReviewedChange={vi.fn()}
        threads={threads}
        commentsEnabled
        commentActions={{} as CommentActions}
        onAddThread={vi.fn()}
        pendingSelection={null}
        onPendingSelectionChange={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe('a comment whose range runs past the end of what is rendered', () => {
  it('is still visible', () => {
    // Written against lines 2-9 of a file the diff only renders two lines of.
    renderWith([thread(2, 9, 'P3: about the end of the file')]);

    expect(screen.getByText(/about the end of the file/)).toBeTruthy();
  });

  it('shows a comment anchored entirely inside the rendered lines', () => {
    renderWith([thread(1, 2, 'P2: about both lines')]);

    expect(screen.getByText(/about both lines/)).toBeTruthy();
  });

  it('shows a single-line comment', () => {
    renderWith([thread(2, 2, 'P1: about line two')]);

    expect(screen.getByText(/about line two/)).toBeTruthy();
  });
});
