import { advanceSession, type ReviewEvent } from './api';
import { appBase } from './base';

/** The same view of another session: the page is served under `/s/<session>`, and the rest of the URL carries over. */
export function sessionHref(
  sessionId: string,
  location: { pathname: string; search: string; hash: string },
  base = appBase(),
): string {
  const rest = base && location.pathname.startsWith(base) ? location.pathname.slice(base.length) : location.pathname;
  return `/s/${encodeURIComponent(sessionId)}${rest || '/'}${location.search}${location.hash}`;
}

/** Replaced in tests, where the page cannot leave. */
export const navigation = {
  replace: (href: string) => window.location.replace(href),
};

export function goToSession(sessionId: string): void {
  navigation.replace(sessionHref(sessionId, window.location));
}

/**
 * Moves the page to the session at the pull request's current head. False when this session is
 * already it, or when `mayLeave` no longer allows it by the time the server has answered, so the
 * page stays.
 */
export async function advanceAndGo(
  currentSessionId: string,
  beforeLeaving?: (sessionId: string) => void,
  mayLeave: () => boolean = () => true,
): Promise<boolean> {
  const { sessionId } = await advanceSession();
  if (sessionId === currentSessionId || !mayLeave()) {
    return false;
  }
  beforeLeaving?.(sessionId);
  goToSession(sessionId);
  return true;
}

/** What the reader had written in the post dialog, kept across the move to a newer session. */
export interface ReviewDraft {
  summary: string | null;
  event: ReviewEvent;
  deselected: string[];
}

const DRAFT_KEY = 'diffity:review-draft:';

export function saveReviewDraft(sessionId: string, draft: ReviewDraft): void {
  try {
    sessionStorage.setItem(DRAFT_KEY + sessionId, JSON.stringify(draft));
  } catch {
    // Without storage the draft is lost; the findings themselves carry over on the server.
  }
}

export function hasReviewDraft(sessionId: string): boolean {
  try {
    return sessionStorage.getItem(DRAFT_KEY + sessionId) !== null;
  } catch {
    return false;
  }
}

/** Read once: a draft restored into the dialog is the dialog's from then on. */
export function takeReviewDraft(sessionId: string): ReviewDraft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY + sessionId);
    sessionStorage.removeItem(DRAFT_KEY + sessionId);
    if (!raw) {
      return null;
    }
    const draft = JSON.parse(raw) as Partial<ReviewDraft>;
    return {
      summary: typeof draft.summary === 'string' ? draft.summary : null,
      event: draft.event === 'APPROVE' || draft.event === 'REQUEST_CHANGES' ? draft.event : 'COMMENT',
      deselected: Array.isArray(draft.deselected) ? draft.deselected.filter((id): id is string => typeof id === 'string') : [],
    };
  } catch {
    return null;
  }
}
