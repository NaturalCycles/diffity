import { describe, it, expect } from 'vitest';
import { pickActiveTour, orderPathsByTour, stopsByPath } from '../src/lib/tour-order';
import type { Tour, TourStep } from '../src/lib/api';

function step(filePath: string, sortOrder: number, annotation = ''): TourStep {
  return {
    id: `s${sortOrder}`,
    tourId: 't',
    sortOrder,
    filePath,
    startLine: 1,
    endLine: 1,
    body: `read ${filePath}`,
    annotation,
    createdAt: '2026-08-21T10:00:00.000Z',
  };
}

function tour(steps: TourStep[], overrides: Partial<Tour> = {}): Tour {
  return {
    id: 't',
    sessionId: 'sess',
    topic: 'Reading order',
    body: '',
    status: 'ready',
    createdAt: '2026-08-21T10:00:00.000Z',
    steps,
    ...overrides,
  };
}

describe('orderPathsByTour', () => {
  const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];

  it('puts the walkthrough first and keeps the rest in their original order', () => {
    expect(orderPathsByTour(paths, ['c.ts', 'a.ts'])).toEqual(['c.ts', 'a.ts', 'b.ts', 'd.ts']);
  });

  it('places a file where it is first visited when the walkthrough returns to it', () => {
    expect(orderPathsByTour(paths, ['d.ts', 'b.ts', 'd.ts'])).toEqual(['d.ts', 'b.ts', 'a.ts', 'c.ts']);
  });

  it('ignores files the walkthrough names but the diff does not contain', () => {
    expect(orderPathsByTour(paths, ['gone.ts', 'b.ts'])).toEqual(['b.ts', 'a.ts', 'c.ts', 'd.ts']);
  });

  it('is the identity when the walkthrough is empty', () => {
    expect(orderPathsByTour(paths, [])).toEqual(paths);
  });

  it('loses no files and duplicates none', () => {
    const ordered = orderPathsByTour(paths, ['c.ts', 'c.ts', 'a.ts']);

    expect([...ordered].sort()).toEqual([...paths].sort());
  });
});

describe('stopsByPath', () => {
  it('numbers files by first visit, not by step', () => {
    const stops = stopsByPath(
      tour([step('a.ts', 1, 'entry point'), step('b.ts', 2), step('a.ts', 3)]),
      ['a.ts', 'b.ts'],
    );

    expect(stops.get('a.ts')).toEqual({ position: 1, count: 2, annotation: 'entry point', body: 'read a.ts' });
    expect(stops.get('b.ts')?.position).toBe(2);
    expect(stops.size).toBe(2);
  });

  it('orders by sortOrder rather than arrival', () => {
    const stops = stopsByPath(tour([step('b.ts', 2), step('a.ts', 1)]), ['a.ts', 'b.ts']);

    expect(stops.get('a.ts')?.position).toBe(1);
    expect(stops.get('b.ts')?.position).toBe(2);
  });

  it('skips files that are not in the diff', () => {
    const stops = stopsByPath(tour([step('gone.ts', 1), step('a.ts', 2)]), ['a.ts']);

    expect(stops.has('gone.ts')).toBe(false);
    expect(stops.get('a.ts')?.position).toBe(1);
  });

  it('is empty without a walkthrough', () => {
    expect(stopsByPath(null, ['a.ts']).size).toBe(0);
  });
});

describe('pickActiveTour', () => {
  it('takes the most recent walkthrough', () => {
    const older = tour([], { id: 'old', createdAt: '2026-08-21T09:00:00.000Z' });
    const newer = tour([], { id: 'new', createdAt: '2026-08-21T11:00:00.000Z' });

    expect(pickActiveTour([older, newer])?.id).toBe('new');
    expect(pickActiveTour([newer, older])?.id).toBe('new');
  });

  it('includes one that is still being written', () => {
    const building = tour([], { id: 'building', status: 'building' });

    expect(pickActiveTour([building])?.id).toBe('building');
  });

  it('returns null when there is none', () => {
    expect(pickActiveTour([])).toBeNull();
    expect(pickActiveTour(undefined)).toBeNull();
  });
});

describe('stopsByPath counts', () => {
  it('counts every stop in a file, so a file read twice says so', () => {
    const stops = stopsByPath(
      tour([step('a.ts', 1), step('b.ts', 2), step('a.ts', 3)]),
      ['a.ts', 'b.ts'],
    );

    expect(stops.get('a.ts')?.count).toBe(2);
    expect(stops.get('b.ts')?.count).toBe(1);
  });
});
