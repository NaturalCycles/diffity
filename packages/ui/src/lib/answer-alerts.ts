import type { Comment, CommentThread } from '../components/comments/types';
import { GENERAL_THREAD_FILE_PATH } from '../components/comments/types';

export interface AnswerAlert {
  threadId: string;
  filePath: string;
  startLine: number;
  /** Arrived while the tab was hidden, so the tab itself carries the news until it is seen. */
  whileHidden: boolean;
}

function isOpenAsk(comment: Comment): boolean {
  return comment.ask === 'pending' || comment.ask === 'working';
}

/**
 * Threads where a question the reader saw waiting has since been answered: its ask settled, or an
 * agent replied under it. Nothing on the first look, since an answer that was already there when
 * the page opened is not news.
 */
export function answeredThreads(
  previous: CommentThread[] | null,
  current: CommentThread[],
): CommentThread[] {
  if (!previous) {
    return [];
  }

  const previousById = new Map(previous.map(thread => [thread.id, thread]));
  const answered: CommentThread[] = [];

  for (const thread of current) {
    const before = previousById.get(thread.id);
    const openAsks = before?.comments.filter(isOpenAsk) ?? [];
    if (!before || openAsks.length === 0) {
      continue;
    }

    const seenIds = new Set(before.comments.map(comment => comment.id));
    const settled = openAsks.some(ask => thread.comments.find(comment => comment.id === ask.id)?.ask === 'answered');
    const replied = thread.comments.some(comment => !seenIds.has(comment.id) && comment.author.type === 'agent');
    if (settled || replied) {
      answered.push(thread);
    }
  }

  return answered;
}

export function toAlert(thread: CommentThread, whileHidden: boolean): AnswerAlert {
  return { threadId: thread.id, filePath: thread.filePath, startLine: thread.startLine, whileHidden };
}

/** One entry per thread: a second answer on the same thread is the same news. */
export function addAlerts(existing: AnswerAlert[], fresh: AnswerAlert[]): AnswerAlert[] {
  const byThread = new Map(existing.map(alert => [alert.threadId, alert]));
  for (const alert of fresh) {
    const known = byThread.get(alert.threadId);
    byThread.set(alert.threadId, known ? { ...known, whileHidden: known.whileHidden || alert.whileHidden } : alert);
  }
  return [...byThread.values()];
}

/** Returns the same array when nothing changed, so a caller can skip the state update. */
export function dropSeenAlerts(
  alerts: AnswerAlert[],
  isOnScreen: (threadId: string) => boolean,
): AnswerAlert[] {
  const kept = alerts.filter(alert => !isOnScreen(alert.threadId));
  return kept.length === alerts.length ? alerts : kept;
}

export function alertLabel(alert: AnswerAlert): string {
  if (alert.filePath === GENERAL_THREAD_FILE_PATH) {
    return 'General';
  }
  const fileName = alert.filePath.split('/').pop() || alert.filePath;
  return `${fileName}:${alert.startLine}`;
}

interface VerticalSpan {
  top: number;
  bottom: number;
}

export function overlaps(rect: VerticalSpan, viewport: VerticalSpan): boolean {
  return rect.bottom > viewport.top && rect.top < viewport.bottom;
}

/**
 * A thread far from the reader is not rendered at all, which answers the question as well as a
 * measurement would.
 */
export function isThreadOnScreen(threadId: string): boolean {
  const element = document.querySelector(`[data-thread-id="${threadId}"]`);
  if (!element) {
    return false;
  }

  const scroller = element.closest('main')?.getBoundingClientRect();
  const viewport = {
    top: Math.max(0, scroller?.top ?? 0),
    bottom: Math.min(window.innerHeight, scroller?.bottom ?? window.innerHeight),
  };
  return overlaps(element.getBoundingClientRect(), viewport);
}
