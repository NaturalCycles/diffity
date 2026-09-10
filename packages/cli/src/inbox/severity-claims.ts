import { readFileSync } from 'node:fs';
import { GENERAL_THREAD_FILE_PATH, type BundleThread, type BundleTour } from '@diffity/api';
import { findingSeverities, type FindingThread } from './summary.js';

/**
 * The severities prose can name, in the two vocabularies a review is written in. A plural counts:
 * "two P1s remain" is how a count is written, and the suffix stays outside the capture so the
 * label still normalises to the one spelling.
 */
const CLAIM = /\b(p[1-3]|must-fix)(?:e?s)?\b/gi;

/** How far back a denial reaches: "no P1", "not a P1", "without a P1" all fit in a dozen characters. */
const NEGATION_WINDOW = 12;

/** A denial of what follows it, as long as no sentence ends in between. */
const DENIAL = /\b(?:no|not|without|zero)\b[^.!?;\n]*$/i;

/**
 * The severities a piece of prose asserts, spelled as `severityOf` spells them and each named
 * once. A mention that is denied is not an assertion: "no P1 in this change" and "there is not a
 * P1 here" claim nothing, which is worth getting right because the whole point of reading these
 * is to catch prose that outruns the findings.
 *
 * This is a deliberate heuristic, not a parser of English: a denial counts only when one of four
 * words sits within `NEGATION_WINDOW` characters before the mention with no sentence end between
 * them. A denial further away than that reads as a claim, which errs towards asking the reviewer
 * to look rather than towards posting something wrong.
 */
export function claimedSeverities(text: string): string[] {
  const claims: string[] = [];
  for (const match of text.matchAll(CLAIM)) {
    const at = match.index ?? 0;
    if (DENIAL.test(text.slice(Math.max(0, at - NEGATION_WINDOW), at))) {
      continue;
    }
    const label = /^must-fix$/i.test(match[1]) ? match[1].toLowerCase() : match[1].toUpperCase();
    if (!claims.includes(label)) {
      claims.push(label);
    }
  }
  return claims;
}

/**
 * The severities the prose asserts that no finding of the review actually carries. A severity is
 * backed by any finding the reviewer still has to act on — the same threads the summary counts —
 * so a claim survives here only when nothing anchored in the diff bears it out.
 */
export function unbackedClaims(text: string, threads: FindingThread[]): string[] {
  const backed = new Set(findingSeverities(threads));
  return claimedSeverities(text).filter(claim => !backed.has(claim));
}

/**
 * The same question asked of a bundle on disk: every piece of prose the agent left in it — the
 * general summary, and the walkthrough's topic, body, step bodies and step annotations — read
 * against the bundle's own findings. Empty for a file that is not a bundle this can read, as with
 * the summary of one.
 */
export function unbackedBundleClaims(bundlePath: string): string[] {
  try {
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf-8')) as { threads?: unknown; tours?: unknown };
    if (!Array.isArray(bundle.threads)) {
      return [];
    }
    const threads = bundle.threads as BundleThread[];
    const tours = Array.isArray(bundle.tours) ? bundle.tours as BundleTour[] : [];
    return unbackedClaims(bundleProse(threads, tours), threads);
  } catch {
    return [];
  }
}

/** Everything in a bundle that is the agent's own words rather than an anchored finding. */
function bundleProse(threads: BundleThread[], tours: BundleTour[]): string {
  const general = threads
    .filter(thread => thread.filePath === GENERAL_THREAD_FILE_PATH)
    .flatMap(thread => (thread.comments ?? []).map(comment => comment.body ?? ''));
  const walkthrough = tours.flatMap(tour => [
    tour.topic ?? '',
    tour.body ?? '',
    ...(tour.steps ?? []).flatMap(step => [step.annotation ?? '', step.body ?? '']),
  ]);
  return [...general, ...walkthrough].join('\n');
}
