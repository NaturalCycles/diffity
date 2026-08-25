export const MIN_EDIT_ROWS = 4;

/** Roughly the line height at the size comments are set in, for turning rows into pixels. */
const ROW_HEIGHT = 21;
const MAX_EDIT_ROWS = 24;

export const MIN_EDIT_HEIGHT = MIN_EDIT_ROWS * ROW_HEIGHT;
export const MAX_EDIT_HEIGHT = MAX_EDIT_ROWS * ROW_HEIGHT;

/**
 * How tall the box for editing a comment should be. The height comes from the element measuring its
 * own wrapped content — a character count guesses, and guesses differently in split and unified view
 * — and this only decides how far it is allowed to go.
 *
 * A fixed three rows meant editing a long finding through a letterbox; past the maximum the box
 * would push the diff off screen, and scrolling inside it is the lesser evil.
 */
export function clampEditHeight(measured: number): number {
  return Math.min(MAX_EDIT_HEIGHT, Math.max(MIN_EDIT_HEIGHT, measured));
}
