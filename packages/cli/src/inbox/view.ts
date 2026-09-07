import { isRetired, type InboxPr, type InboxStore, type RunTotals } from './store.js';
import { costOf, minutesOf, runDetail } from './runs.js';
import { BUMPABLE } from './open.js';

/** What the agent runs behind a prepared review came to, as its card shows it. */
export interface RunSpend {
  minutes: number;
  /** null when no run behind this head reported a cost. */
  costUsd: number | null;
  /** One line per run — phase, model, turns, tokens — for the hover. */
  detail: string;
}

/** One row as the inbox surface shows it: what it is, what was done, and whether it needs a look. */
export interface InboxRow {
  id: string;
  number: number;
  repo: string;
  title: string;
  url: string;
  author: string;
  status: InboxPr['status'];
  statusReason: string | null;
  changedFiles: number;
  additions: number;
  deletions: number;
  createdAt: string | null;
  updatedAt: string | null;
  /** A prepared review whose head has since moved: openable, but out of date. */
  stale: boolean;
  preparedAt: string | null;
  /** The findings by severity, once prepared. */
  summary: string | null;
  /** The agent's reason this one needs the reviewer now, when it raised one. */
  alert: string | null;
  openUrl: string | null;
  /** Where a POST dismisses it; null while it is being prepared, and once it is retired. */
  dismissUrl: string | null;
  /** Where a POST bumps it to the front of the queue; null unless it is queued, skipped or failed and not bumped already. */
  prepareUrl: string | null;
  bumped: boolean;
  /** What the prepared review cost in agent runs; null when none were recorded for that head. */
  spend: RunSpend | null;
}

export interface InboxView {
  /** Ready to open, smallest first — what the reviewer acts on. */
  ready: InboxRow[];
  /** Being prepared or waiting to be. */
  working: InboxRow[];
  /** Skipped, drafts or failed — shown for the record, with the reason. */
  other: InboxRow[];
  /** Set aside by the reviewer; listed so a bump can bring one back. */
  dismissed: InboxRow[];
  generatedAt: string;
  /** What the agent has spent, today and over the last seven days. */
  runs: { today: RunTotals; week: RunTotals };
  /** Until when preparation is held back — the reviewer's Claude limit — or null when it is not. */
  pausedUntil: string | null;
}

export function buildView(store: InboxStore, openBase: string, now: string): InboxView {
  const rows = store.all().map(pr => toRow(pr, openBase, store));
  const ready = rows.filter(row => row.status === 'prepared' || row.status === 'stale')
    .sort((a, b) => diffSize(a) - diffSize(b));
  const working = rows.filter(row => row.status === 'queued' || row.status === 'preparing')
    .sort((a, b) => Number(b.bumped) - Number(a.bumped));
  const dismissed = rows.filter(row => row.status === 'dismissed');
  const other = rows.filter(row => !ready.includes(row) && !working.includes(row) && !dismissed.includes(row) && !isRetired(row.status));
  return { ready, working, other, dismissed, generatedAt: now, runs: runWindows(store, now), pausedUntil: store.pausedUntil(now) };
}

/** The two windows the footer shows, on the reviewer's own clock. */
function runWindows(store: InboxStore, now: string): { today: RunTotals; week: RunTotals } {
  const at = Number.isNaN(Date.parse(now)) ? new Date() : new Date(now);
  const midnight = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const weekAgo = new Date(at.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { today: store.runTotals(midnight.toISOString()), week: store.runTotals(weekAgo.toISOString()) };
}

function spendOf(store: InboxStore, pr: InboxPr): RunSpend | null {
  if (pr.preparedHeadSha === null) {
    return null;
  }
  const runs = store.latestRunsFor(pr.id, pr.preparedHeadSha);
  return runs.length === 0
    ? null
    : { minutes: minutesOf(runs), costUsd: costOf(runs), detail: runs.map(runDetail).join('\n') };
}

function toRow(pr: InboxPr, openBase: string, store: InboxStore): InboxRow {
  const stale = pr.status === 'stale'
    || (pr.status === 'prepared' && pr.preparedHeadSha != null && pr.preparedHeadSha !== pr.headSha);
  const openable = pr.status === 'prepared' || pr.status === 'stale';
  const bumpable = BUMPABLE.has(pr.status);
  return {
    id: pr.id,
    number: pr.number,
    repo: pr.repo,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    status: pr.status,
    statusReason: pr.statusReason,
    changedFiles: pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    stale,
    preparedAt: pr.preparedAt,
    summary: pr.summary,
    alert: pr.alert,
    openUrl: openable ? `${openBase}/open/${encodeURIComponent(pr.id)}` : null,
    dismissUrl: pr.status === 'preparing' || pr.status === 'dismissed' || isRetired(pr.status) ? null : `${openBase}/dismiss/${encodeURIComponent(pr.id)}`,
    prepareUrl: bumpable && pr.bumpedAt === null ? `${openBase}/prepare/${encodeURIComponent(pr.id)}` : null,
    bumped: pr.bumpedAt !== null,
    spend: spendOf(store, pr),
  };
}

function diffSize(row: InboxRow): number {
  return row.additions + row.deletions;
}
