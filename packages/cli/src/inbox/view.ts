import type { InboxPr, InboxStore } from './store.js';

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
  /** A prepared review whose head has since moved: openable, but out of date. */
  stale: boolean;
  preparedAt: string | null;
  openUrl: string | null;
}

export interface InboxView {
  /** Ready to open, smallest first — what the reviewer acts on. */
  ready: InboxRow[];
  /** Being prepared or waiting to be. */
  working: InboxRow[];
  /** Skipped, retired or failed — shown for the record, with the reason. */
  other: InboxRow[];
  generatedAt: string;
}

export function buildView(store: InboxStore, openBase: string, now: string): InboxView {
  const rows = store.all().map(pr => toRow(pr, openBase));
  const ready = rows.filter(row => row.status === 'prepared' || row.status === 'stale')
    .sort((a, b) => diffSize(a) - diffSize(b));
  const working = rows.filter(row => row.status === 'queued' || row.status === 'preparing');
  const other = rows.filter(row => !ready.includes(row) && !working.includes(row) && row.status !== 'hidden' && row.status !== 'done');
  return { ready, working, other, generatedAt: now };
}

function toRow(pr: InboxPr, openBase: string): InboxRow {
  const stale = pr.status === 'stale'
    || (pr.status === 'prepared' && pr.preparedHeadSha != null && pr.preparedHeadSha !== pr.headSha);
  const openable = pr.status === 'prepared' || pr.status === 'stale';
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
    stale,
    preparedAt: pr.preparedAt,
    openUrl: openable ? `${openBase}/open/${encodeURIComponent(pr.id)}` : null,
  };
}

function diffSize(row: InboxRow): number {
  return row.additions + row.deletions;
}
