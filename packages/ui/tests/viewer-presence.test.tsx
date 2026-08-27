import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useViewerPresence } from '../src/hooks/use-viewer-presence';

function Page() {
  useViewerPresence(true);
  return null;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useViewerPresence', () => {
  it('says the window is open straight away, and keeps saying it', () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}'))));

    render(<Page />);
    expect(fetch).toHaveBeenCalledWith('/api/viewer', expect.objectContaining({ method: 'POST' }));

    const first = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    act(() => void vi.advanceTimersByTime(30_000));
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(first);
  });

  // A hidden tab has its timers throttled, so the heartbeat alone can go stale.
  it('says so again as soon as the tab is looked at', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}'))));
    render(<Page />);
    const before = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(before + 1);
  });

  // The whole point: closing the tab is known at once rather than inferred from silence.
  it('sends a beacon when the page goes away', () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}'))));
    vi.stubGlobal('navigator', { ...navigator, sendBeacon });

    render(<Page />);
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(sendBeacon).toHaveBeenCalledWith('/api/viewer/gone');
  });

  it('stops beating when the page unmounts', () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}'))));

    const { unmount } = render(<Page />);
    unmount();
    const after = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    act(() => void vi.advanceTimersByTime(60_000));

    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(after);
  });
});
