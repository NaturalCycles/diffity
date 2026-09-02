import {
  COMMENT_KINDS,
  COMMENT_SIDES,
  THREAD_STATUSES,
  type CommentAuthor,
  type CommentKind,
  type CommentSide,
  type ThreadStatus,
} from './threads.js';
import { TOUR_STATUSES, type TourStatus } from './tours.js';
import type { GitHubRemote } from './github.js';
import {
  FieldError,
  author,
  int,
  lineRange,
  list,
  member,
  optInt,
  optStr,
  parseWith,
  record,
  str,
  timestamp,
  type ParseResult,
} from './parse.js';

/**
 * A prepared review in portable form: the threads and walkthrough tours of one session, pinned to
 * the commit whose working tree their line numbers mean. Everything machine- and forge-local —
 * ids, live state, what was submitted where — stays behind; an import mints its own.
 */
export interface ReviewBundle {
  formatVersion: number;
  /** The commit the anchors mean: importing onto any other HEAD would misplace every line. */
  headSha: string;
  /** The session ref the bundle was exported from, and the base it resolved to at export time. */
  ref: string;
  baseSha: string | null;
  repo: GitHubRemote | null;
  prNumber: number | null;
  createdAt: string;
  /** Who or what prepared this, free text — shown so a reader knows the findings' provenance. */
  generator: string;
  threads: BundleThread[];
  tours: BundleTour[];
}

export interface BundleThread {
  filePath: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
  status: ThreadStatus;
  anchorContent: string | null;
  comments: BundleComment[];
}

export interface BundleComment {
  author: CommentAuthor;
  body: string;
  kind: CommentKind;
  createdAt: string;
}

export interface BundleTour {
  topic: string;
  body: string;
  status: TourStatus;
  steps: BundleTourStep[];
}

export interface BundleTourStep {
  filePath: string;
  startLine: number;
  endLine: number;
  body: string;
  annotation: string;
}

export const BUNDLE_FORMAT_VERSION = 1;

export function parseReviewBundle(value: unknown): ParseResult<ReviewBundle> {
  return parseWith(value, obj => {
    const formatVersion = int(obj.formatVersion, 'formatVersion', 1);
    if (formatVersion > BUNDLE_FORMAT_VERSION) {
      throw new FieldError(
        `formatVersion ${formatVersion} is newer than this diffity understands (${BUNDLE_FORMAT_VERSION})`,
      );
    }
    return {
      formatVersion,
      headSha: str(obj.headSha, 'headSha'),
      ref: str(obj.ref, 'ref'),
      baseSha: obj.baseSha == null ? null : str(obj.baseSha, 'baseSha'),
      repo: bundleRepo(obj.repo),
      prNumber: optInt(obj.prNumber, 'prNumber', 1) ?? null,
      createdAt: timestamp(obj.createdAt, 'createdAt'),
      generator: str(obj.generator, 'generator'),
      threads: list(obj.threads, 'threads').map((item, index) => bundleThread(item, `threads[${index}]`)),
      tours: list(obj.tours, 'tours').map((item, index) => bundleTour(item, `tours[${index}]`)),
    };
  }, 'The bundle');
}

function bundleRepo(value: unknown): GitHubRemote | null {
  if (value == null) {
    return null;
  }
  const obj = record(value, 'repo');
  return {
    owner: str(obj.owner, 'repo.owner'),
    repo: str(obj.repo, 'repo.repo'),
  };
}

function bundleThread(value: unknown, label: string): BundleThread {
  const obj = record(value, label);
  const comments = list(obj.comments, `${label}.comments`)
    .map((item, index) => bundleComment(item, `${label}.comments[${index}]`));
  if (comments.length === 0) {
    throw new FieldError(`${label}.comments must not be empty`);
  }
  return {
    filePath: str(obj.filePath, `${label}.filePath`),
    side: member(obj.side, `${label}.side`, COMMENT_SIDES),
    // Line 0 is real: a general comment is about the whole diff and sits on no line.
    ...lineRange(obj, 0, label),
    status: member(obj.status, `${label}.status`, THREAD_STATUSES),
    anchorContent: optStr(obj.anchorContent, `${label}.anchorContent`) ?? null,
    comments,
  };
}

function bundleComment(value: unknown, label: string): BundleComment {
  const obj = record(value, label);
  return {
    author: author(obj.author, `${label}.author`),
    body: str(obj.body, `${label}.body`),
    kind: member(obj.kind, `${label}.kind`, COMMENT_KINDS),
    createdAt: timestamp(obj.createdAt, `${label}.createdAt`),
  };
}

function bundleTour(value: unknown, label: string): BundleTour {
  const obj = record(value, label);
  return {
    topic: str(obj.topic, `${label}.topic`),
    body: optStr(obj.body, `${label}.body`) ?? '',
    status: member(obj.status, `${label}.status`, TOUR_STATUSES),
    steps: list(obj.steps, `${label}.steps`)
      .map((item, index) => bundleTourStep(item, `${label}.steps[${index}]`)),
  };
}

function bundleTourStep(value: unknown, label: string): BundleTourStep {
  const obj = record(value, label);
  return {
    filePath: str(obj.filePath, `${label}.filePath`),
    ...lineRange(obj, 0, label),
    body: optStr(obj.body, `${label}.body`) ?? '',
    annotation: optStr(obj.annotation, `${label}.annotation`) ?? '',
  };
}
