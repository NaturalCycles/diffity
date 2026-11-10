import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { MovedOn } from '../lib/api';
import { advanceAndGo } from '../lib/session-head';

/**
 * A page opened on an outdated session moves to the current one before the reader starts. Once the
 * reader is in it, the page never switches by itself: a head that moves meanwhile is offered as an
 * update instead.
 */
export function useFollowHead(sessionId: string | null, movedOn: MovedOn | null | undefined) {
  const checked = useRef(false);
  const [updating, setUpdating] = useState(false);

  const update = useCallback(async () => {
    if (!sessionId) {
      return;
    }
    setUpdating(true);
    try {
      if (!(await advanceAndGo(sessionId))) {
        setUpdating(false);
      }
    } catch (err) {
      setUpdating(false);
      toast.error('Could not update to the pull request’s current head', {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [sessionId]);

  useEffect(() => {
    if (checked.current || !sessionId) {
      return;
    }
    checked.current = true;
    if (movedOn) {
      void update();
    }
  }, [sessionId, movedOn, update]);

  return { movedOn: movedOn ?? null, updating, update };
}
