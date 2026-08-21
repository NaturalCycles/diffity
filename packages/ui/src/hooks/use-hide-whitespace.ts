import { useCallback, useState } from 'react';

const STORAGE_KEY = 'diffity-hide-whitespace';

/**
 * On by default: whitespace is the formatter's business, so it should not spend a reviewer's
 * attention. The toolbar shows when it is on, because a filtered diff renders fewer lines than
 * the forge does and that must never be silent.
 */
function readStored(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }
  return localStorage.getItem(STORAGE_KEY) !== 'false';
}

export function useHideWhitespace() {
  const [hideWhitespace, setHideWhitespace] = useState<boolean>(readStored);

  const setAndRemember = useCallback((hide: boolean) => {
    setHideWhitespace(hide);
    localStorage.setItem(STORAGE_KEY, String(hide));
  }, []);

  return { hideWhitespace, setHideWhitespace: setAndRemember };
}
