import { describe, it, expect } from 'vitest';
import {
  TOUR_NOT_STARTED,
  tourPositionLabel,
  nextTourStep,
  prevTourStep,
  canRestartTour,
  clampTourStep,
} from '../src/lib/tour-navigation';

describe('tourPositionLabel', () => {
  it('reads 0 of n before the walkthrough is started', () => {
    expect(tourPositionLabel(TOUR_NOT_STARTED, 7)).toBe('0/7');
  });

  it('counts from one once a stop is current', () => {
    expect(tourPositionLabel(0, 7)).toBe('1/7');
    expect(tourPositionLabel(6, 7)).toBe('7/7');
  });
});

describe('nextTourStep', () => {
  // The bug this exists for: the stepper used to open on step 1 without having gone there, so
  // the first press of "next" moved to step 2 and step 1 was never shown.
  it('goes to the first stop from the not-started state', () => {
    expect(nextTourStep(TOUR_NOT_STARTED, 7)).toBe(0);
  });

  it('advances one stop at a time', () => {
    expect(nextTourStep(0, 7)).toBe(1);
    expect(nextTourStep(5, 7)).toBe(6);
  });

  it('has nowhere to go from the last stop', () => {
    expect(nextTourStep(6, 7)).toBeNull();
  });

  it('has nowhere to go in an empty walkthrough', () => {
    expect(nextTourStep(TOUR_NOT_STARTED, 0)).toBeNull();
  });
});

describe('prevTourStep', () => {
  it('steps back', () => {
    expect(prevTourStep(3, 7)).toBe(2);
  });

  it('stops at the first stop rather than returning to not-started', () => {
    expect(prevTourStep(0, 7)).toBeNull();
  });

  it('has nowhere to go before the walkthrough is started', () => {
    expect(prevTourStep(TOUR_NOT_STARTED, 7)).toBeNull();
  });
});

describe('canRestartTour', () => {
  it('is offered only once you have moved past the first stop', () => {
    expect(canRestartTour(TOUR_NOT_STARTED)).toBe(false);
    expect(canRestartTour(0)).toBe(false);
    expect(canRestartTour(1)).toBe(true);
  });
});

describe('clampTourStep', () => {
  // The stepper used to clamp for its own display while the diff got the raw value, so a
  // walkthrough replaced mid-session left the header on the last stop and nothing marked current.
  it('leaves a valid index alone', () => {
    expect(clampTourStep(3, 7)).toBe(3);
    expect(clampTourStep(6, 7)).toBe(6);
  });

  it('pulls an index past the end back to the last stop', () => {
    expect(clampTourStep(6, 3)).toBe(2);
  });

  it('keeps the not-started state', () => {
    expect(clampTourStep(TOUR_NOT_STARTED, 7)).toBe(TOUR_NOT_STARTED);
  });

  it('has nothing to point at in an empty walkthrough', () => {
    expect(clampTourStep(0, 0)).toBe(TOUR_NOT_STARTED);
  });
});
