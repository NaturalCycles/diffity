import { readFileSync } from 'node:fs';
import type { BundleThread } from '@diffity/api';
import { GENERAL_THREAD_FILE_PATH } from '@diffity/api';

const ORDER = ['P1', 'P2', 'P3', 'must-fix', 'suggestion', 'question', 'other'];

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
 * "1 P1 · 2 P2", counting each finding thread by the severity it opens with. The general summary is
 * not a finding, and a thread the checking pass dismissed or resolved is not one the reviewer has
 * left to act on.
 */
export function summarizeFindings(threads: Pick<BundleThread, 'filePath' | 'status' | 'comments'>[]): string {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    if (thread.filePath === GENERAL_THREAD_FILE_PATH || thread.status !== 'open') {
      continue;
    }
    const finding = thread.comments.find(comment => comment.kind === 'review') ?? thread.comments[0];
    if (!finding) {
      continue;
    }
    const label = severityOf(finding.body);
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
