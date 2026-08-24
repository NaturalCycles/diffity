import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { TourStepper } from '../src/components/diff/tour-stepper';
import { TOUR_NOT_STARTED } from '../src/lib/tour-navigation';
import type { Tour, TourStep } from '../src/lib/api';

function step(sortOrder: number, filePath: string): TourStep {
  return {
    id: `s${sortOrder}`,
    tourId: 't',
    sortOrder,
    filePath,
    startLine: 1,
    endLine: 2,
    body: `read ${filePath}`,
    annotation: '',
    createdAt: '2026-08-24T10:00:00.000Z',
  };
}

function tour(count: number): Tour {
  return {
    id: 't',
    sessionId: 'sess',
    topic: 'Reading order',
    body: 'Two features and a README catch-up.',
    status: 'ready',
    createdAt: '2026-08-24T10:00:00.000Z',
    steps: Array.from({ length: count }, (_, i) => step(i + 1, `f${i + 1}.ts`)),
  };
}

function renderStepper(stepIndex: number, onStepChange = vi.fn()) {
  render(<TourStepper tour={tour(7)} stepIndex={stepIndex} onStepChange={onStepChange} />);
  return onStepChange;
}

afterEach(cleanup);

describe('TourStepper before it is started', () => {
  it('counts from zero, because it has not taken you anywhere yet', () => {
    renderStepper(TOUR_NOT_STARTED);

    expect(screen.getByText('0/7')).toBeTruthy();
  });

  it('shows the walkthrough topic rather than a stop it has not gone to', () => {
    renderStepper(TOUR_NOT_STARTED);

    expect(screen.getByText(/Reading order/)).toBeTruthy();
    expect(screen.queryByText('f1.ts')).toBeNull();
  });

  // The bug: it opened on 1/7 without scrolling there, so the first press went to 2/7.
  it('goes to the first stop on the first press', () => {
    const onStepChange = renderStepper(TOUR_NOT_STARTED);

    screen.getByTitle('Start the walkthrough').click();

    expect(onStepChange).toHaveBeenCalledWith(0);
  });

  it('has nothing to go back to', () => {
    renderStepper(TOUR_NOT_STARTED);

    expect(screen.getByTitle('Previous stop').hasAttribute('disabled')).toBe(true);
  });

  it('offers no restart, since there is nothing to restart from', () => {
    renderStepper(TOUR_NOT_STARTED);

    expect(screen.queryByTitle('Back to the first stop')).toBeNull();
  });
});

describe('TourStepper once it is started', () => {
  it('counts from one and shows the stop', () => {
    renderStepper(0);

    expect(screen.getByText('1/7')).toBeTruthy();
    expect(screen.getByText('f1.ts')).toBeTruthy();
  });

  it('advances one stop at a time', () => {
    const onStepChange = renderStepper(2);

    screen.getByTitle('Next stop').click();

    expect(onStepChange).toHaveBeenCalledWith(3);
  });

  it('steps back', () => {
    const onStepChange = renderStepper(2);

    screen.getByTitle('Previous stop').click();

    expect(onStepChange).toHaveBeenCalledWith(1);
  });

  it('cannot advance past the last stop', () => {
    renderStepper(6);

    expect(screen.getByTitle('Next stop').hasAttribute('disabled')).toBe(true);
  });

  it('jumps back to the first stop', () => {
    const onStepChange = renderStepper(4);

    screen.getByTitle('Back to the first stop').click();

    expect(onStepChange).toHaveBeenCalledWith(0);
  });

  it('offers no restart while already on the first stop', () => {
    renderStepper(0);

    expect(screen.queryByTitle('Back to the first stop')).toBeNull();
  });
});
