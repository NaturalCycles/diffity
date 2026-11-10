import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { MovedOn } from '../lib/api';
import { advanceAndGo } from '../lib/session-head';
import { readPageState, safeToLeave } from '../lib/sign-in';

function postDialogOpen(doc: Document = document): boolean {
  return doc.querySelector('[data-post-dialog]') !== null;
}

/**
 * A page opened on an outdated session moves to the current one before the reader starts. Later it
 * follows the head only while nobody is looking at it — the tab hidden, or just shown again — and
 * only when nothing would be lost: no draft, no field being edited, no save under way, no post
 * dialog open. Otherwise, and always while the reader is on the page, a head that moves is offered
 * as an update instead. It never moves while a review of this session is queued or under way,
 * whose findings would land where the reader no longer looks.
 */
export function useFollowHead(sessionId: string | null, movedOn: MovedOn | null | undefined, reviewing = false) {
  const checked = useRef(false);
  const inFlight = useRef(false);
  const [updating, setUpdating] = useState(false);

  const update = useCallback(async (mayLeave?: () => boolean) => {
    if (!sessionId || inFlight.current) {
      return;
    }
    inFlight.current = true;
    setUpdating(true);
    try {
      if (!(await advanceAndGo(sessionId, undefined, mayLeave))) {
        inFlight.current = false;
        setUpdating(false);
      }
    } catch (err) {
      inFlight.current = false;
      setUpdating(false);
      toast.error('Could not update to the pull request’s current head', {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [sessionId]);

  const followIfUnattended = useCallback(() => {
    const unattended = () => !reviewing && safeToLeave(readPageState()) && !postDialogOpen();
    if (!movedOn || !unattended()) {
      return;
    }
    void update(unattended);
  }, [movedOn, reviewing, update]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    if (!checked.current) {
      checked.current = true;
      if (movedOn && !reviewing) {
        void update(() => safeToLeave(readPageState()));
      }
      return;
    }
    if (document.visibilityState === 'hidden') {
      followIfUnattended();
    }
  }, [sessionId, movedOn, reviewing, update, followIfUnattended]);

  useEffect(() => {
    document.addEventListener('visibilitychange', followIfUnattended);
    return () => document.removeEventListener('visibilitychange', followIfUnattended);
  }, [followIfUnattended]);

  return { movedOn: movedOn ?? null, updating, update: () => update() };
}
