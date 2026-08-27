import { useEffect } from 'react';

const BEAT_MS = 15_000;

/**
 * Tells the server this window is open, and tells it once when it closes.
 *
 * An agent waiting for a question has no other way to know: the page holds no connection, and its
 * ordinary polling stops while the tab is hidden, so silence does not mean the window is gone. The
 * closing message goes by `sendBeacon`, which is delivered during unload where a normal request is
 * abandoned.
 */
export function useViewerPresence(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const beat = (): void => {
      void fetch('/api/viewer', { method: 'POST', keepalive: true }).catch(() => {});
    };

    beat();
    const timer = setInterval(beat, BEAT_MS);
    // A hidden tab has its timers throttled, so say so again as soon as it is looked at.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        beat();
      }
    };
    const onHide = (): void => {
      navigator.sendBeacon?.('/api/viewer/gone');
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', onHide);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onHide);
    };
  }, [enabled]);
}
