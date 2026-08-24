import { useEffect, useRef, useState } from 'react';
import { fetchDiffFingerprint } from '../lib/api';
import { changedSince, type FileChurn } from '../lib/stale-files';

const POLL_INTERVAL = 3000;

export function useDiffStaleness(ref?: string, enabled = true, pollIntervalMs = POLL_INTERVAL) {
  const [isStale, setIsStale] = useState(false);
  const [staleFiles, setStaleFiles] = useState<string[]>([]);
  const baselineRef = useRef<string | null>(null);
  const baselineFilesRef = useRef<FileChurn | null>(null);
  const latestFilesRef = useRef<FileChurn | null>(null);

  function resetStaleness() {
    baselineRef.current = null;
    baselineFilesRef.current = null;
    latestFilesRef.current = null;
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
        }
        latestFilesRef.current = files;
        if (fingerprint !== baselineRef.current) {
          // Stale because the fingerprint moved. Naming the files is a bonus on top of that: a new
          // commit changes what a range means without any one file's line changing.
          setIsStale(true);
          setStaleFiles(changedSince(baselineFilesRef.current, files));
        }
      } catch {
        // ignore fetch errors
      }

      if (!cancelled) {
        timer = setTimeout(poll, pollIntervalMs);
      }
    }

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ref, enabled, pollIntervalMs]);

  /**
   * One file has been brought up to date. Its churn becomes the new baseline for that file alone,
   * so it stops being reported while everything else that moved still is.
   */
  function acknowledgeFile(path: string) {
    setStaleFiles(prev => {
      const left = prev.filter(file => file !== path);
      if (left.length === 0) {
        setIsStale(false);
      }
      return left;
    });
    if (baselineFilesRef.current && latestFilesRef.current) {
      baselineFilesRef.current = {
        ...baselineFilesRef.current,
        [path]: latestFilesRef.current[path],
      };
    }
  }

  return { isStale, staleFiles, resetStaleness, acknowledgeFile };
}
