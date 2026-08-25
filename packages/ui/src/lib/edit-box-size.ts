export const MIN_EDIT_ROWS = 4;
export const MAX_EDIT_ROWS = 24;

/** Roughly how many characters fit on a line in the comment column before it wraps. */
const CHARS_PER_ROW = 80;

/**
 * How tall the box should be to edit a body without scrolling it. A fixed three rows meant editing
 * a long finding through a letterbox; past MAX_EDIT_ROWS the box would push the diff off screen,
 * and scrolling inside it becomes the lesser evil.
 */
export function rowsForBody(body: string): number {
  const rows = body
    .split('\n')
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / CHARS_PER_ROW)), 0);

  return Math.min(MAX_EDIT_ROWS, Math.max(MIN_EDIT_ROWS, rows));
}
