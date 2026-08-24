import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DiffFile, DiffHunk, DiffLine } from '@diffity/parser';
import { FileBlock } from '../src/components/diff/file-block';
import type { CommentActions } from '../src/hooks/use-comment-actions';
import { TOUR_NOT_STARTED } from '../src/lib/tour-navigation';
import type { TourMark } from '../src/lib/tour-marks';

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
  return { oldPath: path, newPath: path, status: 'modified', hunks, additions: 1, deletions: 0, isBinary: false };
}

function mark(stepIndex: number, startLine: number, endLine: number, annotation = '', body = ''): TourMark {
  return {
    stepIndex,
    position: stepIndex + 1,
    filePath: 'src/a.ts',
    startLine,
    endLine,
    annotation,
    body,
  };
}

const commentActions = {} as CommentActions;

function renderWithMarks(
  target: DiffFile,
  marks: TourMark[],
  activeStepIndex = TOUR_NOT_STARTED,
  onTourMarkClick = vi.fn(),
  viewMode: 'unified' | 'split' = 'unified',
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <FileBlock
        file={target}
        viewMode={viewMode}
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
        focusRanges={marks.map(m => ({ startLine: m.startLine, endLine: m.endLine, stepIndex: m.stepIndex }))}
        tourMarks={marks}
        activeStepIndex={activeStepIndex}
        onTourMarkClick={onTourMarkClick}
      />
    </QueryClientProvider>,
  );
  return onTourMarkClick;
}

function tbodyClasses(): string[] {
  return Array.from(document.querySelectorAll('tbody')).map(body => body.className);
}

afterEach(cleanup);

const threeLines = hunkAt(40, [
  line('add', 'const a = 1;', 40),
  line('add', 'const b = 2;', 41),
  line('add', 'const c = 3;', 42),
]);

describe('FileBlock walkthrough marks', () => {
  it('puts a lamp on the line the stop begins at', () => {
    renderWithMarks(file('src/a.ts', [threeLines]), [mark(0, 41, 42, 'the marker')]);

    const lamps = screen.getAllByRole('button', { name: /walkthrough stop/i });
    expect(lamps).toHaveLength(1);
  });

  it('does not repeat the lamp down the rest of the range', () => {
    renderWithMarks(file('src/a.ts', [threeLines]), [mark(0, 40, 42)]);

    expect(screen.getAllByRole('button', { name: /walkthrough stop/i })).toHaveLength(1);
  });

  it('names the stop, so the reader knows which one it is', () => {
    renderWithMarks(file('src/a.ts', [threeLines]), [mark(2, 40, 40, 'the marker')]);

    expect(screen.getByRole('button', { name: 'Walkthrough stop 3 — the marker' })).toBeTruthy();
  });

  it('jumps to that stop when clicked', () => {
    const onTourMarkClick = renderWithMarks(file('src/a.ts', [threeLines]), [mark(4, 40, 40)]);

    screen.getByRole('button', { name: /walkthrough stop 5/i }).click();

    expect(onTourMarkClick).toHaveBeenCalledWith(4);
  });

  it('shows a lamp for each stop when a file has several', () => {
    renderWithMarks(file('src/a.ts', [threeLines]), [mark(0, 40, 40), mark(3, 42, 42)]);

    expect(screen.getAllByRole('button', { name: /walkthrough stop/i })).toHaveLength(2);
  });
});

describe('FileBlock highlight tells the current stop from the others', () => {
  const twoHunks = [
    hunkAt(10, [line('add', 'first();', 10)]),
    hunkAt(40, [line('add', 'second();', 40)]),
  ];

  it('gives the current stop a stronger highlight than the rest', () => {
    renderWithMarks(file('src/a.ts', twoHunks), [mark(0, 10, 10), mark(1, 40, 40)], 1);

    const classes = tbodyClasses();
    expect(classes.some(c => c.includes('bg-accent/15'))).toBe(true);
    expect(classes.some(c => c.includes('bg-accent/5') && !c.includes('bg-accent/15'))).toBe(true);
  });

  it('highlights every stop weakly while none is current', () => {
    renderWithMarks(file('src/a.ts', twoHunks), [mark(0, 10, 10), mark(1, 40, 40)], TOUR_NOT_STARTED);

    const classes = tbodyClasses();
    expect(classes.some(c => c.includes('bg-accent/15'))).toBe(false);
    expect(classes.some(c => c.includes('bg-accent/5'))).toBe(true);
  });

  // The tooltip used to sit over the code being read. The lamp's note replaced it.
  it('puts no tooltip on the code it highlights', () => {
    renderWithMarks(file('src/a.ts', twoHunks), [mark(0, 10, 10), mark(1, 40, 40)], 1);

    expect(document.querySelectorAll('tbody[title]')).toHaveLength(0);
  });
});

describe('FileBlock line anchors', () => {
  // scrollToLine finds its target by this attribute; without it a jump lands on the top of the
  // file, and the file only becomes active once the reader scrolls by hand.
  it('labels each row with its new-side line number', () => {
    renderWithMarks(file('src/a.ts', [threeLines]), []);

    expect(document.querySelector('[data-new-line="41"]')).toBeTruthy();
    expect(document.querySelector('[data-new-line="42"]')).toBeTruthy();
  });
});

describe('FileBlock walkthrough notes', () => {
  const noted = [mark(2, 40, 40, 'the marker', 'The one design decision in this PR.')];

  it('says nothing until the lamp is hovered', () => {
    renderWithMarks(file('src/a.ts', [threeLines]), noted);

    expect(screen.queryByText(/The one design decision/)).toBeNull();
  });

  it('shows the whole note on hover, without a click', () => {
    renderWithMarks(file('src/a.ts', [threeLines]), noted);

    fireEvent.mouseEnter(screen.getByRole('button', { name: /walkthrough stop 3/i }));

    expect(screen.getByText(/The one design decision/)).toBeTruthy();
    expect(screen.getByText(/the marker/)).toBeTruthy();
  });

  it('puts it away again', () => {
    renderWithMarks(file('src/a.ts', [threeLines]), noted);
    const lamp = screen.getByRole('button', { name: /walkthrough stop 3/i });

    fireEvent.mouseEnter(lamp);
    fireEvent.mouseLeave(lamp);

    expect(screen.queryByText(/The one design decision/)).toBeNull();
  });

  it('opens over the old side in split view, so it never covers the code under review', () => {
    renderWithMarks(file('src/a.ts', [threeLines]), noted, TOUR_NOT_STARTED, vi.fn(), 'split');

    fireEvent.mouseEnter(screen.getByRole('button', { name: /walkthrough stop 3/i }));

    expect(screen.getByRole('tooltip').className).toContain('right-full');
  });

  // Unified has a single code column and nothing to the left of its first gutter.
  it('opens the other way in unified view, where there is no old side', () => {
    renderWithMarks(file('src/a.ts', [threeLines]), noted);

    fireEvent.mouseEnter(screen.getByRole('button', { name: /walkthrough stop 3/i }));

    expect(screen.getByRole('tooltip').className).toContain('left-full');
  });

  it('marks the stop in split view too', () => {
    renderWithMarks(file('src/a.ts', [threeLines]), noted, TOUR_NOT_STARTED, vi.fn(), 'split');

    expect(screen.getAllByRole('button', { name: /walkthrough stop 3/i })).toHaveLength(1);
  });

  // Two stops on one line are one thing to say about that block, not two lamps to hunt between.
  it('merges stops that share a line into one note', () => {
    renderWithMarks(file('src/a.ts', [threeLines]), [
      mark(0, 40, 40, 'first', 'What the first stop says.'),
      mark(3, 40, 41, 'second', 'What the fourth stop says.'),
    ]);

    const lamps = screen.getAllByRole('button', { name: /walkthrough stop/i });
    expect(lamps).toHaveLength(1);

    fireEvent.mouseEnter(lamps[0]);

    expect(screen.getByText(/What the first stop says/)).toBeTruthy();
    expect(screen.getByText(/What the fourth stop says/)).toBeTruthy();
  });
});
