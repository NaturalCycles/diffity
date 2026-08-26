import { describe, it, expect, beforeEach } from 'vitest';
import { noteViewerSeen, lastViewerSeenAt, viewerIsPresent, viewerHasGone, resetViewerSeen, VIEWER_IDLE_MS } from '../src/viewers.js';

beforeEach(resetViewerSeen);

describe('viewerIsPresent', () => {
  it('is nobody until a page has ever asked for something', () => {
    expect(viewerIsPresent(lastViewerSeenAt(), 1_000)).toBe(false);
  });

  it('is somebody just after a request', () => {
    noteViewerSeen(1_000);

    expect(viewerIsPresent(lastViewerSeenAt(), 1_000)).toBe(true);
  });

  it('is still somebody inside the idle window, since the page polls', () => {
    noteViewerSeen(1_000);

    expect(viewerIsPresent(lastViewerSeenAt(), 1_000 + VIEWER_IDLE_MS - 1)).toBe(true);
  });

  it('is nobody once the polling stops', () => {
    noteViewerSeen(1_000);

    expect(viewerIsPresent(lastViewerSeenAt(), 1_000 + VIEWER_IDLE_MS)).toBe(false);
  });
});

describe('viewerHasGone', () => {
  it('is false when no window has ever been open, because waiting is early not pointless', () => {
    expect(viewerHasGone(0, 1_000_000)).toBe(false);
  });

  it('is false while a window is still polling', () => {
    expect(viewerHasGone(1_000, 1_000)).toBe(false);
  });

  it('is true once one that was open stops', () => {
    expect(viewerHasGone(1_000, 1_000 + VIEWER_IDLE_MS)).toBe(true);
  });
});
