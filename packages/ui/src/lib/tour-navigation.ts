/**
 * The walkthrough opens on no stop at all. Opening on the first stop would claim the page is
 * showing something it never scrolled to, and the first press of "next" would then move to the
 * second stop — skipping the first entirely.
 */
export const TOUR_NOT_STARTED = -1;

export function tourPositionLabel(stepIndex: number, total: number): string {
  return `${stepIndex + 1}/${total}`;
}

export function nextTourStep(stepIndex: number, total: number): number | null {
  if (total === 0 || stepIndex >= total - 1) {
    return null;
  }
  return stepIndex + 1;
}

export function prevTourStep(stepIndex: number, total: number): number | null {
  if (stepIndex <= 0) {
    return null;
  }
  return stepIndex - 1;
}

export function canRestartTour(stepIndex: number): boolean {
  return stepIndex > 0;
}

/**
 * The header and the diff have to agree on which stop is current, so the index is clamped once,
 * where it lives, rather than by each consumer against its own idea of the length.
 */
export function clampTourStep(stepIndex: number, total: number): number {
  if (total === 0 || stepIndex < 0) {
    return TOUR_NOT_STARTED;
  }
  return Math.min(stepIndex, total - 1);
}
