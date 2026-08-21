import type { Tour } from './api';

export interface TourFileStop {
  /** 1-based position of the file in the reading order. */
  position: number;
  annotation: string;
  body: string;
}

export function pickActiveTour(tours: Tour[] | undefined | null): Tour | null {
  if (!tours || tours.length === 0) {
    return null;
  }
  return tours.reduce((latest, tour) => (tour.createdAt > latest.createdAt ? tour : latest));
}

/**
 * Files the walkthrough visits come first, in the order it visits them; everything else keeps
 * the order the diff already had. A file the walkthrough mentions but the diff does not contain
 * is dropped rather than inventing a row for it.
 */
export function orderPathsByTour(paths: string[], tourPaths: string[]): string[] {
  const available = new Set(paths);
  const ordered: string[] = [];
  const placed = new Set<string>();

  for (const path of tourPaths) {
    if (available.has(path) && !placed.has(path)) {
      ordered.push(path);
      placed.add(path);
    }
  }

  for (const path of paths) {
    if (!placed.has(path)) {
      ordered.push(path);
    }
  }

  return ordered;
}

/**
 * The first stop at each file, keyed by path. A walkthrough that returns to a file later still
 * numbers it by where it was first read.
 */
export function stopsByPath(tour: Tour | null, availablePaths: string[]): Map<string, TourFileStop> {
  const stops = new Map<string, TourFileStop>();
  if (!tour) {
    return stops;
  }

  const available = new Set(availablePaths);
  const steps = [...tour.steps].sort((a, b) => a.sortOrder - b.sortOrder);

  for (const step of steps) {
    if (!available.has(step.filePath) || stops.has(step.filePath)) {
      continue;
    }
    stops.set(step.filePath, {
      position: stops.size + 1,
      annotation: step.annotation,
      body: step.body,
    });
  }

  return stops;
}
