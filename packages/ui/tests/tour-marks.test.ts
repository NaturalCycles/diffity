import { describe, it, expect } from 'vitest';
import { tourMarks, marksByPath, marksStartingAt, focusRangesFromMarks, stopTitle, anchorLineInHunks } from '../src/lib/tour-marks';
import { TOUR_NOT_STARTED } from '../src/lib/tour-navigation';
import type { Tour, TourStep } from '../src/lib/api';

function step(filePath: string, sortOrder: number, startLine: number, endLine: number, annotation = ''): TourStep {
  return {
    id: `s${sortOrder}`,
    tourId: 't',
    sortOrder,
    filePath,
    startLine,
    endLine,
    body: `read ${filePath}`,
    annotation,
    createdAt: '2026-08-21T10:00:00.000Z',
  };
}

function tour(steps: TourStep[]): Tour {
  return {
    id: 't',
    sessionId: 'sess',
    topic: 'Reading order',
    body: '',
    status: 'ready',
    createdAt: '2026-08-21T10:00:00.000Z',
    steps,
  };
}

describe('tourMarks', () => {
  it('numbers the stops in reading order, not in the order the steps arrived', () => {
    const marks = tourMarks(tour([
      step('b.ts', 2, 10, 12),
      step('a.ts', 1, 1, 3),
    ]));

    expect(marks.map(m => [m.position, m.filePath])).toEqual([
      [1, 'a.ts'],
      [2, 'b.ts'],
    ]);
  });

  it('carries the zero-based index the stepper uses alongside the display position', () => {
    const marks = tourMarks(tour([step('a.ts', 1, 1, 3), step('b.ts', 2, 10, 12)]));

    expect(marks.map(m => m.stepIndex)).toEqual([0, 1]);
  });

  it('is empty without a walkthrough', () => {
    expect(tourMarks(null)).toEqual([]);
  });
});

describe('marksByPath', () => {
  it('groups every stop in a file, including a second visit', () => {
    const marks = tourMarks(tour([
      step('a.ts', 1, 1, 3),
      step('b.ts', 2, 10, 12),
      step('a.ts', 3, 40, 44),
    ]));

    const byPath = marksByPath(marks);
    expect(byPath.get('a.ts')?.map(m => m.position)).toEqual([1, 3]);
    expect(byPath.get('b.ts')?.map(m => m.position)).toEqual([2]);
  });
});

describe('marksStartingAt', () => {
  const marks = tourMarks(tour([step('a.ts', 1, 10, 14), step('a.ts', 2, 40, 40)]));

  // The lamp goes on the line the stop begins at. Putting one on every line of the range would
  // paint five lamps down the gutter for a five-line stop.
  it('marks the first line of a range and no other line in it', () => {
    expect(marksStartingAt(marks, 10)).toHaveLength(1);
    expect(marksStartingAt(marks, 11)).toEqual([]);
    expect(marksStartingAt(marks, 14)).toEqual([]);
  });

  it('marks a single-line stop', () => {
    expect(marksStartingAt(marks, 40)).toHaveLength(1);
  });

  it('returns both stops when two begin on the same line', () => {
    const overlapping = tourMarks(tour([step('a.ts', 1, 5, 9), step('a.ts', 2, 5, 6)]));
    expect(marksStartingAt(overlapping, 5)).toHaveLength(2);
  });
});

describe('focusRangesFromMarks', () => {
  it('keeps the stop index on the range so a highlight can tell which stop it belongs to', () => {
    const marks = tourMarks(tour([step('a.ts', 1, 10, 14), step('b.ts', 2, 1, 2)]));

    expect(focusRangesFromMarks(marksByPath(marks).get('a.ts') ?? [])).toEqual([
      { startLine: 10, endLine: 14, stepIndex: 0 },
    ]);
  });
});

describe('stopTitle', () => {
  const marks = tourMarks(tour([
    step('a.ts', 1, 10, 14, 'the marker'),
    step('a.ts', 2, 40, 40),
  ]));

  // The old copy read "The walkthrough points here" on every highlighted hunk at once, which said
  // nothing about which stop you were looking at or whether it was the one in the header.
  it('names the stop rather than saying only that one exists', () => {
    expect(stopTitle([marks[0]], TOUR_NOT_STARTED)).toBe('Walkthrough stop 1 — the marker');
  });

  it('says which stop you are on', () => {
    expect(stopTitle([marks[0]], 0)).toBe('Walkthrough stop 1 — the marker (you are here)');
  });

  it('does not claim you are here when a different stop is current', () => {
    expect(stopTitle([marks[1]], 0)).toBe('Walkthrough stop 2');
  });

  it('lists both when two stops share a hunk', () => {
    expect(stopTitle(marks, TOUR_NOT_STARTED)).toBe('Walkthrough stops 1, 2');
  });

  it('has nothing to say without a stop', () => {
    expect(stopTitle([], 0)).toBeUndefined();
  });
});

describe('stopTitle with several stops in one hunk', () => {
  const marks = tourMarks(tour([
    step('a.ts', 1, 10, 14, 'the marker'),
    step('a.ts', 2, 12, 13),
  ]));

  // The hunk still gets the current-stop highlight, so the label has to agree with it.
  it('says which of them you are on', () => {
    expect(stopTitle(marks, 1)).toBe('Walkthrough stops 1, 2 — you are on 2');
  });

  it('says nothing extra when none of them is current', () => {
    expect(stopTitle(marks, TOUR_NOT_STARTED)).toBe('Walkthrough stops 1, 2');
  });
});

describe('anchorLineInHunks', () => {
  const hunks = [
    { header: '', oldStart: 10, oldCount: 3, newStart: 10, newCount: 3, lines: [] },
    { header: '', oldStart: 40, oldCount: 5, newStart: 40, newCount: 5, lines: [] },
  ];

  it('keeps a start line that the diff renders', () => {
    expect(anchorLineInHunks(hunks, 41, 43)).toBe(41);
  });

  // A step can point at a line in the gap between two hunks — unchanged code the diff does not
  // show. The lamp then belongs on the first line of the stop that is actually on screen.
  it('moves to the first rendered line of the range', () => {
    expect(anchorLineInHunks(hunks, 20, 41)).toBe(40);
  });

  it('has nowhere to go when no line of the range is rendered', () => {
    expect(anchorLineInHunks(hunks, 20, 30)).toBeNull();
  });

  it('handles a single-line stop inside a hunk', () => {
    expect(anchorLineInHunks(hunks, 12, 12)).toBe(12);
  });
});
