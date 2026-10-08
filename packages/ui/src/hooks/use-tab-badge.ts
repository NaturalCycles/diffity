import { useEffect, useRef } from 'react';
import { addBadge, titleWithCount, toHref } from '../lib/favicon-badge';

/** Marks the browser tab and its title while `count` answers wait unseen. */
export function useTabBadge(count: number): void {
  const plainHref = useRef<string | null>(null);
  const plainSvg = useRef<string | null>(null);
  const hasUnread = count > 0;

  useEffect(() => {
    document.title = titleWithCount(document.title, count);
  }, [count]);

  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      return;
    }
    plainHref.current ??= link.getAttribute('href');
    const href = plainHref.current;
    if (!href) {
      return;
    }

    if (!hasUnread) {
      link.setAttribute('href', href);
      return;
    }

    let cancelled = false;
    const badge = (svg: string): void => {
      if (!cancelled) {
        link.setAttribute('href', toHref(addBadge(svg)));
      }
    };

    if (plainSvg.current !== null) {
      badge(plainSvg.current);
    } else {
      void fetch(href)
        .then(res => (res.ok ? res.text() : Promise.reject(new Error(res.statusText))))
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

  useEffect(() => () => {
    document.title = titleWithCount(document.title, 0);
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link && plainHref.current) {
      link.setAttribute('href', plainHref.current);
    }
  }, []);
}
