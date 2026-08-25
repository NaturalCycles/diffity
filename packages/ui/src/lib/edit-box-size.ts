export const MIN_EDIT_ROWS = 4;

/** Roughly the line height at the size comments are set in, for turning rows into pixels. */
const ROW_HEIGHT = 21;
const MAX_EDIT_ROWS = 24;

export const MIN_EDIT_HEIGHT = MIN_EDIT_ROWS * ROW_HEIGHT;
export const MAX_EDIT_HEIGHT = MAX_EDIT_ROWS * ROW_HEIGHT;

/** The element measures its own wrapped height; this only decides how far it may go. */
export function clampEditHeight(measured: number): number {
  return Math.min(MAX_EDIT_HEIGHT, Math.max(MIN_EDIT_HEIGHT, measured));
}
