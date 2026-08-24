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
