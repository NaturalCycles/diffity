import type { CommentThread } from '../components/comments/types';
import { isAside } from './live-mode';

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
  if (!previous) {
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
