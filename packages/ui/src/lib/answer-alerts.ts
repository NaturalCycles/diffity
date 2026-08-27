import type { CommentThread } from '../components/comments/types';
import { isAside } from './live-mode';
import type { ThreadPosition } from './thread-visibility';

export interface AnswerAlert {
  threadId: string;
  filePath: string;
  authorName: string;
  preview: string;
}

/** Enough to know whether it needs you now, and no more. */
export const PREVIEW_LINES = 3;
const PREVIEW_CHARS = 220;

/**
 * Answers that have arrived since the last look. An answer is an agent's aside: a finding belongs in
 * the diff rather than in a bubble, and your own comment appearing is not news to you.
 *
 * Nothing on the first look, when every comment is new and everything would be announced at once.
 */
export function newAnswers(
  previous: CommentThread[] | null,
  current: CommentThread[],
): AnswerAlert[] {
  // An empty previous is a page that has not loaded its threads yet, not a review with no comments
  // — announcing against it turns a reload into the whole conversation arriving at once.
  if (!previous || previous.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  for (const thread of previous) {
    for (const comment of thread.comments) {
      seen.add(comment.id);
    }
  }

  const alerts: AnswerAlert[] = [];
  for (const thread of current) {
    for (const comment of thread.comments) {
      if (seen.has(comment.id) || comment.author.type !== 'agent' || !isAside(comment)) {
        continue;
      }
      alerts.push({
        threadId: thread.id,
        filePath: thread.filePath,
        authorName: comment.author.name,
        preview: previewOf(comment.body),
      });
    }
  }

  return alerts;
}

export function previewOf(body: string): string {
  const lines = body.split('\n').filter(line => line.trim() !== '');
  const kept = lines.slice(0, PREVIEW_LINES).join('\n');
  const trimmedLines = lines.length > PREVIEW_LINES;

  if (kept.length <= PREVIEW_CHARS) {
    return trimmedLines ? `${kept}…` : kept;
  }
  return `${kept.slice(0, PREVIEW_CHARS).trimEnd()}…`;
}

/**
 * Seeing the reply is an answer to the note about it, so a thread the reader has scrolled to no
 * longer needs announcing. Returns the same array when nothing changed, so a caller can skip the
 * state update.
 */
export function dropSeenAlerts(
  alerts: AnswerAlert[],
  isOnScreen: (threadId: string) => boolean,
): AnswerAlert[] {
  const kept = alerts.filter(alert => !isOnScreen(alert.threadId));
  return kept.length === alerts.length ? alerts : kept;
}

/** A thread far from the reader is not rendered, so file order answers it when the DOM cannot. */
export function positionForAlert(
  alertFilePath: string,
  activeFilePath: string | null,
  orderedPaths: string[],
  measured: ThreadPosition | null,
): ThreadPosition {
  if (measured) {
    return measured;
  }
  if (!activeFilePath) {
    return 'below';
  }

  const alertAt = orderedPaths.indexOf(alertFilePath);
  const readerAt = orderedPaths.indexOf(activeFilePath);
  if (alertAt === -1 || readerAt === -1) {
    return 'below';
  }

  return alertAt < readerAt ? 'above' : 'below';
}

/**
 * Everything the reader has not dealt with yet, whether or not a note is still on screen for it.
 *
 * The bubble and what it leaves behind are two lists, because a note that has had its time is no
 * longer in the way but is still unread. The count has to span both, or it appears to go up when a
 * note expires — the reader sees the number change at the moment nothing actually happened.
 */
export function unreadAlerts(shown: AnswerAlert[], expired: AnswerAlert[]): AnswerAlert[] {
  const byThread = new Map<string, AnswerAlert>();

  for (const alert of [...expired, ...shown]) {
    byThread.set(alert.threadId, alert);
  }

  return [...byThread.values()];
}
