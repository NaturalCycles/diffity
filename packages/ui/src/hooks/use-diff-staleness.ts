import { useEffect, useRef, useState } from 'react';
import { fetchDiffFingerprint } from '../lib/api';
import { changedSince, type FileChurn } from '../lib/stale-files';

const POLL_INTERVAL = 3000;

export function useDiffStaleness(ref?: string, enabled = true) {
  const [isStale, setIsStale] = useState(false);
  const [staleFiles, setStaleFiles] = useState<string[]>([]);
  const baselineRef = useRef<string | null>(null);
  const baselineFilesRef = useRef<FileChurn | null>(null);

  function resetStaleness() {
    baselineRef.current = null;
    baselineFilesRef.current = null;
    setIsStale(false);
    setStaleFiles([]);
  }

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    async function poll() {
      if (cancelled) {
        return;
      }

      try {
        const { fingerprint, files } = await fetchDiffFingerprint(ref);

        if (cancelled) {
          return;
        }

        if (baselineRef.current === null) {
          baselineRef.current = fingerprint;
          baselineFilesRef.current = files;
        } else if (fingerprint !== baselineRef.current) {
          setIsStale(true);
          setStaleFiles(changedSince(baselineFilesRef.current, files));
        }
      } catch {
        // ignore fetch errors
      }

      if (!cancelled) {
        timer = setTimeout(poll, POLL_INTERVAL);
      }
    }

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ref, enabled]);

  return { isStale, staleFiles, resetStaleness };
}
