import {
  BUNDLE_FORMAT_VERSION,
  type BundleThread,
  type BundleTour,
  type GitHubRemote,
  type ReviewBundle,
} from '@diffity/api';
import { getCommitHash, resolveBaseRef } from '@diffity/git';
import { detectRemote } from '@diffity/github';
import { getDb } from './db.js';
import type { Session } from './session.js';
import { addReply, createThread, getThreadsForSession, updateThreadStatus, type Thread } from './threads.js';
import { addTourStep, createTour, getToursForSession, updateTourStatus, type Tour } from './tours.js';

export interface BundleOrigin {
  prNumber: number | null;
  generator: string;
}

/**
 * Pinned to the session's own commit rather than HEAD: the threads were last anchored against
 * that tree, and only reopening the review moves them along with a newer commit.
 */
export function buildBundle(session: Session, origin: BundleOrigin): ReviewBundle {
  return {
    formatVersion: BUNDLE_FORMAT_VERSION,
    headSha: session.headHash,
    ref: session.ref,
    baseSha: baseShaOf(session.ref),
    repo: detectRemote(),
    prNumber: origin.prNumber,
    createdAt: new Date().toISOString(),
    generator: origin.generator,
    threads: getThreadsForSession(session.id).map(thread => ({
      filePath: thread.filePath,
      side: thread.side,
      startLine: thread.startLine,
      endLine: thread.endLine,
      status: thread.status,
      anchorContent: thread.anchorContent,
      comments: thread.comments.map(comment => ({
        author: comment.author,
        body: comment.body,
        kind: comment.kind,
        createdAt: comment.createdAt,
      })),
    })),
    tours: getToursForSession(session.id).map(tour => ({
      topic: tour.topic,
      body: tour.body,
      status: tour.status,
      steps: tour.steps.map(step => ({
        filePath: step.filePath,
        startLine: step.startLine,
        endLine: step.endLine,
        body: step.body,
        annotation: step.annotation,
      })),
    })),
  };
}

/** Sessions without a diff base — the tree browser, an unborn ref — carry no base. */
function baseShaOf(ref: string): string | null {
  try {
    return getCommitHash(resolveBaseRef(ref));
  } catch {
    return null;
  }
}

/**
 * Why the session must not be exported right now, or null when it may. A session left behind by a
 * commit still holds its findings at the old lines; reopening the review carries them across.
 */
export function exportMismatch(session: Session, head: string): string | null {
  if (session.headHash !== head) {
    return `The session was anchored at ${session.headHash.slice(0, 12)}, but HEAD is ${head.slice(0, 12)}. Open the review once so the findings follow the commit, then export.`;
  }
  return null;
}

/**
 * Why the bundle must not be imported here, or null when it may. Anchors are line numbers in the
 * bundle's HEAD: on any other commit they may point at the wrong lines, in another repository at
 * nothing at all.
 */
export function importMismatch(bundle: ReviewBundle, head: string, remote: GitHubRemote | null): string | null {
  if (bundle.headSha !== head) {
    return `The bundle was made at ${bundle.headSha.slice(0, 12)}, but HEAD is ${head.slice(0, 12)}.`;
  }
  if (bundle.repo && remote && !sameRepo(bundle.repo, remote)) {
    return `The bundle is for ${bundle.repo.owner}/${bundle.repo.repo}, but this repository is ${remote.owner}/${remote.repo}.`;
  }
  return null;
}

function sameRepo(a: GitHubRemote, b: GitHubRemote): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

/**
 * A caution worth printing before an import that will succeed: a thread on a file outside the
 * session's diff is stored but never shown, and the two refs decide which files that is.
 */
export function scopeWarning(bundle: ReviewBundle, session: Session): string | null {
  if (bundle.ref === session.ref) {
    return null;
  }
  return `The bundle was exported from a session on "${bundle.ref}"; this session is on "${session.ref}". Findings on files outside this diff will not be shown.`;
}

export interface ImportOutcome {
  threadsCreated: number;
  threadsSkipped: number;
  toursCreated: number;
  toursSkipped: number;
}

/**
 * Adds the bundle's threads and tours to the session, skipping what is already there: a thread at
 * the same position opening with the same comment, a tour on the same topic. Importing twice is
 * therefore the same as importing once. All or nothing, so a failed import can be retried without
 * half a thread — its opener but not its replies — blocking the retry as "already present".
 */
export function importBundle(session: Session, bundle: ReviewBundle): ImportOutcome {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const outcome = addBundle(session, bundle);
    db.exec('COMMIT');
    return outcome;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function addBundle(session: Session, bundle: ReviewBundle): ImportOutcome {
  const outcome: ImportOutcome = { threadsCreated: 0, threadsSkipped: 0, toursCreated: 0, toursSkipped: 0 };

  const existingThreads = getThreadsForSession(session.id);
  for (const incoming of bundle.threads) {
    if (existingThreads.some(thread => holdsThread(thread, incoming))) {
      outcome.threadsSkipped++;
      continue;
    }
    const [first, ...replies] = incoming.comments;
    const thread = createThread(
      session.id,
      incoming.filePath,
      incoming.side,
      incoming.startLine,
      incoming.endLine,
      first.body,
      first.author,
      incoming.anchorContent ?? undefined,
      first.kind,
      first.createdAt,
    );
    for (const reply of replies) {
      addReply(thread.id, reply.body, reply.author, reply.kind, reply.createdAt);
    }
    if (incoming.status !== 'open') {
      updateThreadStatus(thread.id, incoming.status);
    }
    outcome.threadsCreated++;
  }

  const existingTours = getToursForSession(session.id);
  for (const incoming of bundle.tours) {
    if (existingTours.some(tour => holdsTour(tour, incoming))) {
      outcome.toursSkipped++;
      continue;
    }
    const tour = createTour(session.id, incoming.topic, incoming.body);
    for (const step of incoming.steps) {
      addTourStep(tour.id, step.filePath, step.startLine, step.endLine, step.body, step.annotation);
    }
    if (incoming.status !== 'building') {
      updateTourStatus(tour.id, incoming.status);
    }
    outcome.toursCreated++;
  }

  return outcome;
}

function holdsThread(thread: Thread, incoming: BundleThread): boolean {
  return thread.filePath === incoming.filePath
    && thread.side === incoming.side
    && thread.startLine === incoming.startLine
    && thread.endLine === incoming.endLine
    && thread.comments[0]?.body === incoming.comments[0].body;
}

function holdsTour(tour: Tour, incoming: BundleTour): boolean {
  return tour.topic === incoming.topic;
}
