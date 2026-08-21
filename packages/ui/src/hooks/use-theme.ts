import { useState, useEffect, useLayoutEffect, useCallback } from 'react';

type Theme = 'light' | 'dark';

function getStoredTheme(): Theme | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return localStorage.getItem('diffity-theme') as Theme | null;
}

export function getTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

function prefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(DARK_QUERY).matches;
}

export function resolveInitialTheme(
  stored: Theme | null,
  initial: Theme | null | undefined,
  systemPrefersDark: boolean,
): Theme {
  return stored ?? initial ?? (systemPrefersDark ? 'dark' : 'light');
}

export function useTheme(initialTheme?: Theme | null) {
  const [theme, setTheme] = useState<Theme>(
    () => resolveInitialTheme(getStoredTheme(), initialTheme, prefersDark())
  );

  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Keep following the system until the reader picks a theme themselves.
  useEffect(() => {
    if (getStoredTheme() || initialTheme || typeof window === 'undefined' || !window.matchMedia) {
      return;
    }

    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent): void => {
      setTheme(event.matches ? 'dark' : 'light');
    };

    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [initialTheme]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === 'light' ? 'dark' : 'light';
      localStorage.setItem('diffity-theme', next);
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
