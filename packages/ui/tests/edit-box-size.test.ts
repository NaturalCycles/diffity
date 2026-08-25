import { describe, it, expect } from 'vitest';
import { clampEditHeight, MIN_EDIT_HEIGHT, MAX_EDIT_HEIGHT } from '../src/lib/edit-box-size';

describe('how tall the box for editing a comment may be', () => {
  // A fixed three rows meant editing a long finding through a letterbox.
  it('takes the measured height when it is reasonable', () => {
    const middling = (MIN_EDIT_HEIGHT + MAX_EDIT_HEIGHT) / 2;

    expect(clampEditHeight(middling)).toBe(middling);
  });

  it('does not collapse for a one-line comment', () => {
    expect(clampEditHeight(10)).toBe(MIN_EDIT_HEIGHT);
  });

  // Past a point the box would push the diff off screen, and scrolling inside it is the lesser evil.
  it('stops growing before it takes over the page', () => {
    expect(clampEditHeight(10_000)).toBe(MAX_EDIT_HEIGHT);
  });

  it('copes with a browser that measured nothing', () => {
    expect(clampEditHeight(0)).toBe(MIN_EDIT_HEIGHT);
  });
});
