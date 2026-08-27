import { useEffect, useRef } from 'react';
import { addBadge, toHref, FAVICON_HREF } from '../lib/favicon-badge';

/**
 * Marks the browser tab while something is unread, so a reader looking at another window can tell
 * there is an answer waiting without switching to find out.
 */
export function useFaviconBadge(hasUnread: boolean): void {
  const plainSvg = useRef<string | null>(null);

  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      return;
    }

    if (!hasUnread) {
      link.href = FAVICON_HREF;
      return;
    }

    let cancelled = false;
    const badge = (svg: string): void => {
      if (!cancelled) {
        link.href = toHref(addBadge(svg));
      }
    };

    if (plainSvg.current !== null) {
      badge(plainSvg.current);
    } else {
      // The icon is served from the same origin, so this is a cache hit in practice.
      void fetch(FAVICON_HREF)
        .then(res => res.text())
        .then(svg => {
          plainSvg.current = svg;
          badge(svg);
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, [hasUnread]);
}
