import { describe, it, expect } from 'vitest';
import { isScrolledPastFileTop } from '../src/lib/collapse-anchor';

describe('isScrolledPastFileTop', () => {
  // The file header is sticky, so it sits at the top of the container while the reader is
  // anywhere inside the file. Marking it viewed collapses it, the page above shortens, and the
  // reader is left looking at files they had already scrolled past.
  it('is true when the file starts above the visible area', () => {
    expect(isScrolledPastFileTop(-800, 0)).toBe(true);
  });

  it('is false when the file header is already where it belongs', () => {
    expect(isScrolledPastFileTop(0, 0)).toBe(false);
  });

  it('is false for a file further down the page', () => {
    expect(isScrolledPastFileTop(400, 0)).toBe(false);
  });

  it('ignores sub-pixel rounding at the boundary', () => {
    expect(isScrolledPastFileTop(-0.4, 0)).toBe(false);
  });

  it('measures against the container, not the window', () => {
    expect(isScrolledPastFileTop(100, 140)).toBe(true);
    expect(isScrolledPastFileTop(180, 140)).toBe(false);
  });
});
