#!/usr/bin/env node

/**
 * Re-prepares one pull request with a candidate model and puts its findings beside the bundle the
 * inbox already has for that head, so a cheaper drafter is judged on what it finds rather than on
 * what it costs. One agent run per invocation; everything it writes stays in a scratch directory.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GENERAL_THREAD_FILE_PATH, parseReviewBundle, type BundleThread, type ReviewBundle } from '@diffity/api';
import { viewPr } from '@diffity/github';
import type { RunStats } from '../packages/cli/src/inbox/agent-output.js';
import { DEFAULT_INBOX_CONFIG, expandHome, type InboxConfig } from '../packages/cli/src/inbox/config.js';
import { preparePr, type PrepareResult } from '../packages/cli/src/inbox/prepare.js';
import { realPrepareDeps } from '../packages/cli/src/inbox/runtime.js';
import { severityOf } from '../packages/cli/src/inbox/summary.js';
import { cloneDir, removeWorktree } from '../packages/cli/src/inbox/worktree.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const USAGE = 'Usage: npx tsx scripts/inbox-compare.ts <owner/repo#n> [--head <sha>] [--model <m>]'
  + ' [--effort <low|medium|high|xhigh|max>] [--bundles-dir <dir>] [--repos-dir <dir>] [--scratch <dir>]'
  + ' [--keep] [--json] [--out <file.md>]';

/** What the caller asked for, over what it did not name. */
export class UsageError extends Error {}

export interface PrRefSpec {
  owner: string;
  repo: string;
  number: number;
}

export interface Options {
  ref: PrRefSpec;
  /** The baseline bundle's head, when the newest one is not the wanted one. */
  head: string | null;
  model: string | null;
  effort: string | null;
  bundlesDir: string;
  reposDir: string;
  /** Where the worktree and the run's diffity data go; null means a fresh temporary directory. */
  scratch: string | null;
  json: boolean;
  out: string | null;
  /** Leave the worktree behind, for reading the candidate's session in the browser. */
  keep: boolean;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The severities a finding can open with, in the order the table lists them. */
const SEVERITY_ORDER = ['P1', 'P2', 'P3', 'must-fix', 'suggestion', 'question', 'other'];

export function parseOptions(argv: string[]): Options {
  let spec: string | null = null;
  let head: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  let bundlesDir = '~/.diffity/inbox/bundles';
  let reposDir = '~/nc/repos';
  let scratch: string | null = null;
  let json = false;
  let out: string | null = null;
  let keep = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`${arg} needs a value`);
      }
      return next;
    };
    switch (arg) {
      case '--head': head = value(); break;
      case '--model': model = value(); break;
      case '--effort': effort = value(); break;
      case '--bundles-dir': bundlesDir = value(); break;
      case '--repos-dir': reposDir = value(); break;
      case '--scratch': scratch = value(); break;
      case '--out': out = value(); break;
      case '--json': json = true; break;
      case '--keep': keep = true; break;
      default:
        if (arg.startsWith('-')) {
          throw new UsageError(`unknown option ${arg}`);
        }
        if (spec !== null) {
          throw new UsageError('one pull request at a time');
        }
        spec = arg;
    }
  }

  if (spec === null) {
    throw new UsageError('name the pull request to compare, as owner/repo#number');
  }
  if (head !== null && !/^[0-9a-f]{7,40}$/i.test(head)) {
    throw new UsageError(`--head ${head} is not a commit sha of at least 7 hex digits`);
  }
  if (effort !== null && !EFFORTS.includes(effort)) {
    throw new UsageError(`--effort must be one of ${EFFORTS.join('|')}`);
  }
  return {
    ref: parsePrSpec(spec),
    head, model, effort, json, keep,
    bundlesDir: expandHome(bundlesDir),
    reposDir: expandHome(reposDir),
    scratch: scratch === null ? null : expandHome(scratch),
    out: out === null ? null : expandHome(out),
  };
}

export function parsePrSpec(spec: string): PrRefSpec {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)$/.exec(spec);
  if (!match) {
    throw new UsageError(`"${spec}" is not a pull request; write it as owner/repo#number`);
  }
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/**
 * The bundle files in the directory that belong to this pull request. Matched by the whole prefix
 * rather than by splitting on the dashes: an owner and a repository name may each hold one.
 */
export function bundleNamesFor(names: string[], ref: PrRefSpec): string[] {
  const prefix = `${ref.owner}-${ref.repo}-${ref.number}-`;
  return names.filter(name => name.startsWith(prefix) && /^[0-9a-f]{7,40}\.json$/i.test(name.slice(prefix.length)));
}

export interface BundleRef {
  path: string;
  headSha: string;
  createdAt: string;
}

/** The newest bundle of the ones given, or the newest at `head` when a head is named. */
export function newestBundle<T extends BundleRef>(bundles: T[], head: string | null): T | null {
  const matching = head === null ? bundles : bundles.filter(bundle => sameHead(bundle.headSha, head));
  return [...matching].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

/** Two shas name the same commit when the shorter is a prefix of the longer. */
export function sameHead(a: string, b: string): boolean {
  const shared = Math.min(a.length, b.length);
  return shared >= 7 && a.slice(0, shared).toLowerCase() === b.slice(0, shared).toLowerCase();
}

export interface Finding {
  severity: string;
  filePath: string;
  startLine: number;
  endLine: number;
  /** The finding's own opening sentence, so a row says what it is about. */
  sentence: string;
}

type ThreadShape = Pick<BundleThread, 'filePath' | 'status' | 'startLine' | 'endLine' | 'comments'>;

/**
 * The findings a reviewer still has to act on: the general summary is not one, and neither is a
 * thread the checking pass dismissed or resolved.
 */
export function findingsOf(threads: ThreadShape[]): Finding[] {
  const findings: Finding[] = [];
  for (const thread of threads) {
    if (thread.filePath === GENERAL_THREAD_FILE_PATH || thread.status !== 'open') {
      continue;
    }
    const comment = thread.comments.find(item => item.kind === 'review') ?? thread.comments[0];
    if (!comment) {
      continue;
    }
    findings.push({
      severity: severityOf(comment.body),
      filePath: thread.filePath,
      startLine: thread.startLine,
      endLine: thread.endLine,
      sentence: firstSentence(comment.body),
    });
  }
  return findings;
}

/** The first sentence without the severity marker the severity column already carries. */
export function firstSentence(body: string, limit = 160): string {
  const text = body
    .replace(/^\s*(?:P[1-3]\b:?|\[(?:must-fix|suggestion|question)\]:?)\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  // A full stop only ends a sentence when something breaks after it, so `0.197` stays whole.
  const match = /^.*?[.!?](?=\s|$)/.exec(text);
  const sentence = (match ? match[0] : text).trim();
  return sentence.length > limit ? `${sentence.slice(0, limit).trimEnd()}…` : sentence;
}

/** How far off a one-line finding may be and still be the same one: two models rarely agree on the line. */
const LINE_SLACK = 2;

export function rangeOf(finding: Pick<Finding, 'startLine' | 'endLine'>): [number, number] {
  return finding.startLine === finding.endLine
    ? [finding.startLine - LINE_SLACK, finding.endLine + LINE_SLACK]
    : [finding.startLine, finding.endLine];
}

/** The same finding: the same file, and line ranges that overlap. */
export function matches(a: Finding, b: Finding): boolean {
  if (a.filePath !== b.filePath) {
    return false;
  }
  const [aStart, aEnd] = rangeOf(a);
  const [bStart, bEnd] = rangeOf(b);
  return aStart <= bEnd && bStart <= aEnd;
}

/** What one agent run spent, as the table prints it. */
export interface Spend {
  costUsd: number | null;
  minutes: number | null;
  turns: number | null;
  outputTokens: number | null;
}

export function spendOf(stats: RunStats | null): Spend {
  return {
    costUsd: stats?.costUsd ?? null,
    minutes: stats?.durationMs == null ? null : stats.durationMs / 60_000,
    turns: stats?.turns ?? null,
    outputTokens: stats === null ? null : stats.outputTokens,
  };
}

export interface BaselineRow extends Finding {
  reproducedBy: Finding | null;
}

export interface SeverityRow {
  severity: string;
  baseline: number;
  reproduced: number;
  added: number;
}

export interface Comparison {
  pr: string;
  head: string;
  candidate: string;
  severities: SeverityRow[];
  baseline: BaselineRow[];
  /** The candidate's findings that no baseline finding covers. */
  added: Finding[];
  spend: Spend;
}

export function compareFindings(input: {
  pr: string;
  head: string;
  candidate: string;
  baseline: Finding[];
  drafted: Finding[];
  spend: Spend;
}): Comparison {
  // Not a pairing: a baseline finding counts as reproduced when any candidate finding lands on it,
  // and a candidate finding is new when none of the baseline's does.
  const baseline: BaselineRow[] = input.baseline.map(finding => ({
    ...finding,
    reproducedBy: input.drafted.find(drafted => matches(finding, drafted)) ?? null,
  }));
  const added = input.drafted.filter(drafted => !input.baseline.some(finding => matches(finding, drafted)));
  return {
    pr: input.pr,
    head: input.head,
    candidate: input.candidate,
    severities: severityRows(baseline, added),
    baseline,
    added,
    spend: input.spend,
  };
}

function severityRows(baseline: BaselineRow[], added: Finding[]): SeverityRow[] {
  return SEVERITY_ORDER
    .filter(severity => baseline.some(row => row.severity === severity) || added.some(row => row.severity === severity))
    .map(severity => ({
      severity,
      baseline: baseline.filter(row => row.severity === severity).length,
      reproduced: baseline.filter(row => row.severity === severity && row.reproducedBy !== null).length,
      added: added.filter(row => row.severity === severity).length,
    }));
}

export function candidateLabel(model: string | null, effort: string | null): string {
  const parts = [model ?? 'default model'];
  if (effort !== null) {
    parts.push(`effort ${effort}`);
  }
  return parts.join(' · ');
}

export function location(finding: Pick<Finding, 'filePath' | 'startLine' | 'endLine'>): string {
  return finding.startLine === finding.endLine
    ? `${finding.filePath}:${finding.startLine}`
    : `${finding.filePath}:${finding.startLine}-${finding.endLine}`;
}

export function renderSpend(spend: Spend): string {
  return [
    spend.costUsd === null ? '—' : `$${spend.costUsd.toFixed(2)}`,
    spend.minutes === null ? '—' : `${spend.minutes.toFixed(1)} min`,
    spend.turns === null ? '—' : `${spend.turns} turns`,
    spend.outputTokens === null ? '—' : `${formatTokens(spend.outputTokens)} out`,
  ].join(' / ');
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/** The block to paste into the issue: the tally, then every finding either side has. */
export function renderMarkdown(comparison: Comparison): string {
  const lines = [
    `### ${comparison.pr} · head ${comparison.head} · candidate: ${comparison.candidate}`,
    '| | baseline (Fable, old pipeline) | candidate |',
    '|---|---|---|',
  ];
  for (const row of comparison.severities) {
    lines.push(`| ${row.severity} | ${row.baseline} | ${row.reproduced} reproduced, ${row.added} new |`);
  }
  lines.push(`| cost / time | — | ${renderSpend(comparison.spend)} |`, '');

  lines.push('Baseline findings:');
  if (comparison.baseline.length === 0) {
    lines.push('- none');
  }
  for (const row of comparison.baseline) {
    const outcome = row.reproducedBy === null
      ? 'not reproduced'
      : `reproduced by ${row.reproducedBy.severity} ${location(row.reproducedBy)}`;
    lines.push(`- ${row.severity} ${location(row)} — ${row.sentence} → ${outcome}`);
  }

  lines.push('New in candidate:');
  if (comparison.added.length === 0) {
    lines.push('- none');
  }
  for (const row of comparison.added) {
    lines.push(`- ${row.severity} ${location(row)} — ${row.sentence}`);
  }
  return `${lines.join('\n')}\n`;
}

function readBundle(path: string): ReviewBundle | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
  const parsed = parseReviewBundle(raw);
  return parsed.ok ? parsed.value : null;
}

/** The bundle the candidate is measured against, by head when one is named and by age otherwise. */
function readBaseline(options: Options): { path: string; bundle: ReviewBundle } {
  if (!existsSync(options.bundlesDir)) {
    throw new UsageError(`no bundles directory at ${options.bundlesDir}`);
  }
  const found = bundleNamesFor(readdirSync(options.bundlesDir), options.ref)
    .map(name => join(options.bundlesDir, name))
    .flatMap(path => {
      const bundle = readBundle(path);
      return bundle === null ? [] : [{ path, bundle, headSha: bundle.headSha, createdAt: bundle.createdAt }];
    });
  const newest = newestBundle(found, options.head);
  if (!newest) {
    const at = options.head === null ? '' : ` at head ${options.head}`;
    throw new UsageError(`no bundle for ${prName(options.ref)}${at} in ${options.bundlesDir}; there is nothing to compare against`);
  }
  return newest;
}

/**
 * The head `refs/pull/<n>/head` points at, fetched into the clone. This is the only head a
 * worktree can be cut at, so it decides whether the baseline's head is still reachable as a
 * checkout — and it is asked before an agent run is spent rather than after.
 */
async function fetchPrHead(clone: string, number: number): Promise<string> {
  const git = (args: string[]) => promisify(execFile)('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: clone, encoding: 'utf-8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  await git(['fetch', 'origin', `refs/pull/${number}/head`]);
  const { stdout } = await git(['rev-parse', 'FETCH_HEAD']);
  return stdout.trim();
}

function prName(ref: PrRefSpec): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

function worktreeOf(result: PrepareResult): string | null {
  return 'worktree' in result ? result.worktree : null;
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : err}`);
    console.error(USAGE);
    return 1;
  }

  const entry = resolve(root, 'packages/cli/dist/index.js');
  let baseline: { path: string; bundle: ReviewBundle };
  const clone = cloneDir(options.reposDir, options.ref.repo);
  try {
    if (!existsSync(entry)) {
      throw new UsageError(`${entry} is missing — run \`npm run build\` first`);
    }
    if (!existsSync(clone)) {
      throw new UsageError(`no clone at ${clone}; clone ${options.ref.owner}/${options.ref.repo} there first`);
    }
    baseline = readBaseline(options);
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  const head = baseline.bundle.headSha;
  const short = head.slice(0, 12);
  console.error(`🔍 ${prName(options.ref)} · baseline ${basename(baseline.path)} of ${baseline.bundle.createdAt}`);

  let current: string;
  try {
    current = await fetchPrHead(clone, options.ref.number);
  } catch (err) {
    console.error(`⏭ ${clone} could not fetch refs/pull/${options.ref.number}/head: ${err instanceof Error ? err.message : err}`);
    return 2;
  }
  if (!sameHead(current, head)) {
    console.error(`⏭ the pull request's head is now ${current.slice(0, 12)}, and a worktree can only be cut at that one; re-run against a bundle at that head, or pick another pull request.`);
    return 2;
  }

  const snapshot = await viewPr(options.ref);
  if (!snapshot) {
    console.error(`⏭ gh could not read ${prName(options.ref)}`);
    return 2;
  }

  const scratch = options.scratch ?? mkdtempSync(join(tmpdir(), 'diffity-compare-'));
  mkdirSync(scratch, { recursive: true });
  // Everything preparing writes — the exported bundle, the agent's log, each session's data — is
  // rooted here, so a comparison never touches the running inbox's own directory.
  process.env.DIFFITY_DATA_DIR = scratch;

  const config: InboxConfig = {
    ...DEFAULT_INBOX_CONFIG,
    reposDir: options.reposDir,
    worktreesDir: join(scratch, 'worktrees'),
    filter: '',
    alertWhen: '',
    alertPaths: [],
    agent: { model: options.model, effort: options.effort, mcpAllow: [], extraArgs: [], maxBudgetUsd: null },
    validate: { ...DEFAULT_INBOX_CONFIG.validate, model: null },
  };
  const candidate = candidateLabel(options.model, options.effort);
  const deps = realPrepareDeps(
    process.execPath, entry,
    worktree => join(scratch, 'data', basename(worktree)),
    config, message => console.error(`   ${message}`),
  );

  console.error(`🤖 preparing ${prName(options.ref)} at ${short} with ${candidate} — agent running…`);
  const startedAt = Date.now();
  const elapsed = () => (Date.now() - startedAt) / 60_000;
  const ticker = setInterval(() => console.error(`   … ${elapsed().toFixed(0)} min`), 60_000);
  let result: PrepareResult;
  try {
    result = await preparePr({ ...snapshot, headSha: head }, config, deps, { bumped: true });
  } finally {
    clearInterval(ticker);
  }
  console.error(`⏱️  the agent stopped after ${elapsed().toFixed(1)} min`);

  const worktree = worktreeOf(result);
  try {
    if (result.kind !== 'prepared') {
      const what = result.kind === 'skipped' ? 'skipped this pull request' : 'failed';
      console.error(`⏭ the candidate ${what}: ${result.reason}`);
      return 2;
    }
    if (!sameHead(result.headSha, head)) {
      console.error(`⏭ the worktree ended up at ${result.headSha.slice(0, 12)}, not the baseline's ${short}; the findings would not be about the same code.`);
      return 2;
    }
    const drafted = readBundle(result.bundlePath);
    if (!drafted) {
      console.error(`⏭ the candidate's bundle at ${result.bundlePath} could not be read`);
      return 2;
    }

    const comparison = compareFindings({
      pr: prName(options.ref),
      head: short,
      candidate,
      baseline: findingsOf(baseline.bundle.threads),
      drafted: findingsOf(drafted.threads),
      spend: spendOf(result.run.stats),
    });
    const markdown = renderMarkdown(comparison);
    if (options.out !== null) {
      mkdirSync(dirname(options.out), { recursive: true });
      writeFileSync(options.out, markdown);
      console.error(`📝 ${options.out}`);
    }
    console.log(options.json ? JSON.stringify(comparison, null, 2) : markdown.trimEnd());
    return 0;
  } finally {
    if (worktree !== null && !options.keep) {
      try {
        await removeWorktree(clone, worktree);
      } catch (err) {
        console.error(`   the worktree at ${worktree} is still there: ${err instanceof Error ? err.message : err}`);
      }
    }
    console.error(`🗂️  the run's data is under ${scratch}`);
  }
}

// Only when run as a script: the test beside this file imports it for the pure functions above.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
