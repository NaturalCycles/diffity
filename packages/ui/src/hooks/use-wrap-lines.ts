import { useState, useLayoutEffect, useCallback } from 'react';

const STORAGE_KEY = 'diffity-wrap-lines';

function getStoredWrapLines(): boolean | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) {
    return null;
  }
  return stored === 'true';
}

export function useWrapLines() {
  const [wrapLines, setWrapLines] = useState<boolean>(
    () => getStoredWrapLines() ?? true
  );

  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-wrap-lines', String(wrapLines));
  }, [wrapLines]);

  const toggleWrapLines = useCallback(() => {
    setWrapLines(prev => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  return { wrapLines, toggleWrapLines };
}
