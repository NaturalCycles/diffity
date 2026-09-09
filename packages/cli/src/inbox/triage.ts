import type { TriageCandidate } from '@diffity/github';
import { titleSkipReason } from './reconcile.js';

/** What a queued row's reason opens with, so the page says why this one jumped the queue. */
export const TRIAGE_PREFIX = 'triage: ';

/** Beyond this a reason says nothing more, and the row it explains stays one line. */
export const MAX_TRIAGE_REASON = 120;

/** A flag as the row carries it. */
export function triageStatusReason(reason: string): string {
  return `${TRIAGE_PREFIX}${reason}`;
}

/**
 * Which of the reviewer's own body patterns the description matches, as the reason to flag the
 * pull request, or null when none does. Matched multiline, so a pattern anchored with `^` and `$`
 * picks out one line of a generated block; the matched text is the reason, held to one line.
 */
export function bodyRuleReason(body: string, patterns: string[]): string | null {
  if (body === '' || patterns.length === 0) {
    return null;
  }
  for (const pattern of patterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'm');
    } catch {
      // The config refuses a pattern that does not compile; one that got here anyway is not worth
      // a failed poll.
      continue;
    }
    const match = regex.exec(body);
    if (match) {
      return cutReason(match[0]);
    }
  }
  return null;
}

/** A reason as a row can carry it: the author's own text, one line, held to a length. */
export function cutReason(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= MAX_TRIAGE_REASON ? line : `${line.slice(0, MAX_TRIAGE_REASON - 1)}…`;
}

/**
 * Why a watched pull request is not worth looking at at all — the reviewer's own, a bot's, or a
 * title they said to skip — or null when it is. Nothing is spent on deciding this.
 */
export function candidateSkipReason(candidate: TriageCandidate, viewerLogin: string | null, skipTitles: string[]): string | null {
  if (candidate.isBot) {
    return `bot author (${candidate.author})`;
  }
  if (viewerLogin && candidate.author && candidate.author === viewerLogin) {
    return 'your own pull request';
  }
  return titleSkipReason(candidate.title, skipTitles);
}

/**
 * What the cheap model answered: a reason to flag, nothing to flag, or no verdict at all — the
 * last of which is a run that went wrong rather than a pull request that is fine.
 */
export type TriageVerdict =
  | { kind: 'flag'; reason: string }
  | { kind: 'none' }
  | { kind: 'missing' };

/** The model's last `TRIAGE:` line, so a prompt it echoed earlier cannot pre-empt its answer. */
export function triageVerdictOf(text: string): TriageVerdict {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^TRIAGE:\s*(.*)$/.exec(lines[i]);
    if (!match) {
      continue;
    }
    const reason = match[1].trim();
    return reason === '' || /^none\.?$/i.test(reason) ? { kind: 'none' } : { kind: 'flag', reason: cutReason(reason) };
  }
  return { kind: 'missing' };
}
