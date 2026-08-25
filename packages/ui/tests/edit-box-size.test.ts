import { describe, it, expect } from 'vitest';
import { rowsForBody, MIN_EDIT_ROWS, MAX_EDIT_ROWS } from '../src/lib/edit-box-size';

describe('how big the box is for editing a comment', () => {
  // A fixed three rows meant editing a long finding through a letterbox, scrolling to find the
  // line you came to change.
  it('grows to fit what is being edited', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');

    expect(rowsForBody(twelve)).toBe(12);
  });

  it('does not collapse for a one-line comment', () => {
    expect(rowsForBody('short')).toBe(MIN_EDIT_ROWS);
  });

  // Past a point the box would push the diff off screen, and scrolling inside it is the lesser evil.
  it('stops growing before it takes over the page', () => {
    const enormous = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');

    expect(rowsForBody(enormous)).toBe(MAX_EDIT_ROWS);
  });

  // A wrapped paragraph takes more rows than it has newlines.
  it('counts a long unbroken line as more than one row', () => {
    expect(rowsForBody('x'.repeat(600))).toBeGreaterThan(MIN_EDIT_ROWS);
  });

  it('copes with an empty body', () => {
    expect(rowsForBody('')).toBe(MIN_EDIT_ROWS);
  });
});
