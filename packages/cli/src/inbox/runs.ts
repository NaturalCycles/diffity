import type { RunRow } from './store.js';

/** A token count as the log shows it: the magnitude is what the reviewer reads, not the digits. */
export function formatTokens(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  if (count < 1_000_000) {
    return `${Math.round(count / 1000)}k`;
  }
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** The two counts worth watching on a review run: what it wrote, and what it re-read. */
export function tokensLabel(run: { outputTokens: number | null; cacheReadTokens: number | null }): string {
  const parts: string[] = [];
  if (run.outputTokens !== null) {
    parts.push(`out ${formatTokens(run.outputTokens)}`);
  }
  if (run.cacheReadTokens !== null) {
    parts.push(`read ${formatTokens(run.cacheReadTokens)}`);
  }
  return parts.join(' · ');
}

export function minutesOf(runs: { durationMs: number | null }[]): number {
  const ms = runs.reduce((total, run) => total + (run.durationMs ?? 0), 0);
  return Math.round(ms / 6000) / 10;
}

/** What the runs cost, or null when not one of them reported a cost. */
export function costOf(runs: { costUsd: number | null }[]): number | null {
  const known = runs.filter(run => run.costUsd !== null);
  return known.length === 0 ? null : known.reduce((total, run) => total + (run.costUsd ?? 0), 0);
}

/** One run on one line, for the hover over a prepared review's cost. */
export function runDetail(run: RunRow): string {
  const parts = [run.phase, run.model ?? 'unknown model'];
  if (run.turns !== null) {
    parts.push(`${run.turns} turns`);
  }
  const tokens = tokensLabel(run);
  if (tokens) {
    parts.push(tokens);
  }
  return parts.join(' · ');
}

export function money(usd: number | null): string {
  return usd === null ? '—' : `$${usd.toFixed(2)}`;
}

/** A moment on the reviewer's own clock, hours and minutes. */
export function localHhMm(iso: string): string {
  const at = new Date(iso);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A moment on the reviewer's own clock, as the run log's first column. */
export function localWhen(iso: string): string {
  const at = new Date(iso);
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${localHhMm(iso)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
