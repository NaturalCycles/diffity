import type { DiffHunk } from '@diffity/parser';
import type { Tour } from './api';

export interface TourMark {
  /** Zero-based index into the sorted steps — what the stepper navigates by. */
  stepIndex: number;
  /** 1-based position shown to the reader. */
  position: number;
  filePath: string;
  startLine: number;
  endLine: number;
  annotation: string;
  body: string;
}

export interface TourFocusRange {
  startLine: number;
  endLine: number;
  stepIndex: number;
}

export function tourMarks(tour: Tour | null | undefined): TourMark[] {
  if (!tour) {
    return [];
  }

  return [...tour.steps]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((step, index) => ({
      stepIndex: index,
      position: index + 1,
      filePath: step.filePath,
      startLine: step.startLine,
      endLine: step.endLine,
      annotation: step.annotation,
      body: step.body,
    }));
}

export function marksByPath(marks: TourMark[]): Map<string, TourMark[]> {
  const byPath = new Map<string, TourMark[]>();
  for (const mark of marks) {
    const existing = byPath.get(mark.filePath);
    if (existing) {
      existing.push(mark);
    } else {
      byPath.set(mark.filePath, [mark]);
    }
  }
  return byPath;
}

/**
 * A stop is marked on the line it begins at and nowhere else — one lamp per stop, rather than one
 * per line of its range. The range itself is already visible as a highlight.
 */
export function marksStartingAt(marks: TourMark[], line: number): TourMark[] {
  return marks.filter(mark => mark.startLine === line);
}

export function focusRangesFromMarks(marks: TourMark[]): TourFocusRange[] {
  return marks.map(mark => ({
    startLine: mark.startLine,
    endLine: mark.endLine,
    stepIndex: mark.stepIndex,
  }));
}

export interface TourStopRef {
  stepIndex: number;
  annotation?: string;
}

/**
 * What a highlighted hunk says on hover. Naming the stop matters because every stop in the file is
 * highlighted at once: without a number, each one claims to be the one the header is showing.
 */
export function stopTitle(stops: TourStopRef[], activeStepIndex: number): string | undefined {
  if (stops.length === 0) {
    return undefined;
  }

  if (stops.length > 1) {
    const positions = stops.map(stop => stop.stepIndex + 1).join(', ');
    const current = stops.find(stop => stop.stepIndex === activeStepIndex);
    const here = current ? ` — you are on ${current.stepIndex + 1}` : '';
    return `Walkthrough stops ${positions}${here}`;
  }

  const [stop] = stops;
  const annotation = stop.annotation ? ` — ${stop.annotation}` : '';
  const here = stop.stepIndex === activeStepIndex ? ' (you are here)' : '';
  return `Walkthrough stop ${stop.stepIndex + 1}${annotation}${here}`;
}

/**
 * Where a stop's lamp belongs. A step can point at a line the diff does not render — unchanged
 * code between two hunks — so the lamp goes on the first line of the range that is on screen.
 * Null means the whole range is outside the diff, and the file list is the only place it shows.
 */
export function anchorLineInHunks(
  hunks: Pick<DiffHunk, 'newStart' | 'newCount'>[],
  startLine: number,
  endLine: number,
): number | null {
  let best: number | null = null;

  for (const hunk of hunks) {
    const from = Math.max(hunk.newStart, startLine);
    const to = Math.min(hunk.newStart + hunk.newCount - 1, endLine);
    if (from <= to && (best === null || from < best)) {
      best = from;
    }
  }

  return best;
}
