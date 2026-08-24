import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import type { DiffFile } from '@diffity/parser';
import { ReviewOrderList } from '../src/components/diff/review-order-list';
import type { TourFileStop } from '../src/lib/tour-order';

function file(path: string): DiffFile {
  return {
    oldPath: path,
    newPath: path,
    status: 'modified',
    hunks: [],
    additions: 1,
    deletions: 0,
    isBinary: false,
  };
}

function stop(position: number, count: number, annotation = ''): TourFileStop {
  return { position, count, annotation, body: '' };
}

function renderList(stops: Map<string, TourFileStop>) {
  render(
    <ReviewOrderList
      files={[file('a.ts'), file('b.ts'), file('c.ts')]}
      stops={stops}
      activeFile={null}
      reviewedFiles={new Set()}
      commentCountsByFile={new Map()}
      onFileClick={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe('ReviewOrderList walkthrough marks', () => {
  it('marks a file the walkthrough stops at', () => {
    renderList(new Map([['a.ts', stop(1, 1)]]));

    expect(screen.getByTitle('1 walkthrough note')).toBeTruthy();
  });

  it('counts the notes when a file is visited more than once', () => {
    renderList(new Map([['a.ts', stop(1, 3)]]));

    const mark = screen.getByTitle('3 walkthrough notes');
    expect(mark.textContent).toContain('3');
  });

  it('leaves a file the walkthrough skips unmarked', () => {
    renderList(new Map([['a.ts', stop(1, 1)]]));

    expect(screen.queryAllByTitle(/walkthrough note/)).toHaveLength(1);
  });
});
