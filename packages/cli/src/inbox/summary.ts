import { readFileSync } from 'node:fs';
import type { BundleThread } from '@diffity/api';
import { GENERAL_THREAD_FILE_PATH } from '@diffity/api';

const ORDER = ['P1', 'P2', 'P3', 'must-fix', 'suggestion', 'question', 'other'];

/**
 * A finding as these read one, structurally rather than by its origin: a bundle's threads and the
 * threads a live session lists both answer to this, so neither has to be converted to the other.
 */
export interface FindingThread {
  filePath: string;
  status: string;
  comments: { body: string; kind?: string }[];
}

/**
 * The severity a finding opens with — `P1: …` or `[must-fix] …` in the vocabularies the review skill
 * uses — or "other" for a finding that names none.
 */
export function severityOf(body: string): string {
  const match = /^\s*(?:(P[1-3])\b|\[(must-fix|suggestion|question)\])/i.exec(body);
  if (!match) {
    return 'other';
  }
  return match[1] ? match[1].toUpperCase() : match[2].toLowerCase();
}

/**
 * The severity of every finding the reviewer still has to act on, in the order the threads come.
 * The general summary is not a finding, and a thread the checking pass dismissed or resolved is
 * not one left to act on — the one place those two rules live.
 */
export function findingSeverities(threads: FindingThread[]): string[] {
  const labels: string[] = [];
  for (const thread of threads) {
    if (thread.filePath === GENERAL_THREAD_FILE_PATH || thread.status !== 'open') {
      continue;
    }
    const finding = thread.comments.find(comment => comment.kind === 'review') ?? thread.comments[0];
    if (finding) {
      labels.push(severityOf(finding.body));
    }
  }
  return labels;
}

/** "1 P1 · 2 P2", counting the findings the reviewer has left to act on by severity. */
export function summarizeFindings(threads: FindingThread[]): string {
  const counts = new Map<string, number>();
  for (const label of findingSeverities(threads)) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0) {
    return 'no findings';
  }
  return ORDER.filter(label => counts.has(label)).map(label => `${counts.get(label)} ${label}`).join(' \u00b7 ');
}

/** The summary of a bundle on disk, or null when the file is not a bundle this can read. */
export function summarizeBundleFile(bundlePath: string): string | null {
  try {
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf-8')) as { threads?: unknown };
    if (!Array.isArray(bundle.threads)) {
      return null;
    }
    return summarizeFindings(bundle.threads as BundleThread[]);
  } catch {
    return null;
  }
}
