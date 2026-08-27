import { describe, it, expect, beforeEach } from 'vitest';
import {
  noteViewerSeen,
  markViewerGone,
  viewerSnapshot,
  viewerIsPresent,
  viewerHasGone,
  resetViewerSeen,
  VIEWER_IDLE_MS,
} from '../src/viewers.js';

beforeEach(resetViewerSeen);

describe('viewerIsPresent', () => {
  it('is nobody until a page has said it is there', () => {
    expect(viewerIsPresent(viewerSnapshot(), 1_000)).toBe(false);
  });

  it('is somebody just after a heartbeat', () => {
    noteViewerSeen(1_000);

    expect(viewerIsPresent(viewerSnapshot(), 1_000)).toBe(true);
  });

  // The window has to be wide enough for a hidden tab, whose timers a browser throttles.
  it('is still somebody inside the idle window', () => {
    noteViewerSeen(1_000);

    expect(viewerIsPresent(viewerSnapshot(), 1_000 + VIEWER_IDLE_MS - 1)).toBe(true);
  });

  it('is nobody once the heartbeat stops', () => {
    noteViewerSeen(1_000);

    expect(viewerIsPresent(viewerSnapshot(), 1_000 + VIEWER_IDLE_MS)).toBe(false);
  });
});

describe('viewerHasGone', () => {
  it('is false when no window has ever been open, because waiting is early not pointless', () => {
    expect(viewerHasGone(viewerSnapshot(), 1_000_000)).toBe(false);
  });

  it('is false while a window is still beating', () => {
    noteViewerSeen(1_000);

    expect(viewerHasGone(viewerSnapshot(), 1_000)).toBe(false);
  });

  it('is true once one that was open falls silent', () => {
    noteViewerSeen(1_000);

    expect(viewerHasGone(viewerSnapshot(), 1_000 + VIEWER_IDLE_MS)).toBe(true);
  });

  // The point of the explicit signal: a closed tab is known at once rather than after three
  // minutes of silence, which is the difference between a loop that stops and one that lingers.
  it('is true immediately when the page says it is going', () => {
    noteViewerSeen(1_000);
    markViewerGone();

    expect(viewerHasGone(viewerSnapshot(), 1_001)).toBe(true);
    expect(viewerIsPresent(viewerSnapshot(), 1_001)).toBe(false);
  });

  it('is false again when the page comes back', () => {
    markViewerGone();
    noteViewerSeen(2_000);

    expect(viewerHasGone(viewerSnapshot(), 2_000)).toBe(false);
  });
});
