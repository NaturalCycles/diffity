import { describe, it, expect } from 'vitest';
import { parseInboxConfig, saveInboxSettings, DEFAULT_INBOX_CONFIG } from '../src/inbox/config.js';
import { severityOf, summarizeFindings } from '../src/inbox/summary.js';
import { parseSettingsPatch } from '../src/inbox/settings.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composePrompt, verdictOf } from '../src/inbox/prompt.js';
import { parseReviewRequested, parsePrSnapshot } from '@diffity/github';
import type { PrSnapshot } from '@diffity/github';

describe('parseInboxConfig', () => {
  it('fills every default from an empty object', () => {
    expect(parseInboxConfig({})).toEqual(DEFAULT_INBOX_CONFIG);
  });

  it('overrides only what is given', () => {
    const config = parseInboxConfig({ pollMinutes: 2, filter: 'skip payments' });
    expect(config.pollMinutes).toBe(2);
    expect(config.filter).toBe('skip payments');
    expect(config.agent).toEqual(DEFAULT_INBOX_CONFIG.agent);
  });

  it('takes the CI hold and the alert paths, and refuses each by name', () => {
    expect(parseInboxConfig({ waitForCi: true, alertPaths: [' packages/shared/src/model/** ', '**/dbref/**'] }))
      .toMatchObject({ waitForCi: true, alertPaths: ['packages/shared/src/model/**', '**/dbref/**'] });
    expect(DEFAULT_INBOX_CONFIG.waitForCi).toBe(false);
    expect(DEFAULT_INBOX_CONFIG.alertPaths).toEqual([]);
    expect(() => parseInboxConfig({ waitForCi: 'yes' })).toThrow(/waitForCi must be true or false/);
    expect(() => parseInboxConfig({ alertPaths: 'src/**' })).toThrow(/alertPaths must be an array of non-empty globs/);
    expect(() => parseInboxConfig({ alertPaths: [' '] })).toThrow(/alertPaths must be an array of non-empty globs/);
  });

  it('takes the title patterns, and refuses a bad one by name', () => {
    expect(parseInboxConfig({ skipTitles: ['\\(payments\\)', 'Release$'] }).skipTitles)
      .toEqual(['\\(payments\\)', 'Release$']);
    expect(DEFAULT_INBOX_CONFIG.skipTitles).toEqual([]);
    expect(() => parseInboxConfig({ skipTitles: '\\(payments\\)' })).toThrow(/skipTitles must be an array of non-empty regular expressions/);
    expect(() => parseInboxConfig({ skipTitles: ['ok', ' '] })).toThrow(/skipTitles must be an array of non-empty regular expressions/);
    expect(() => parseInboxConfig({ skipTitles: ['ok', 3] })).toThrow(/skipTitles must be an array of non-empty regular expressions/);
    // The index says which line to go and fix, and the engine's own words say what is wrong with it.
    expect(() => parseInboxConfig({ skipTitles: ['fine', 'also fine', '(payments'] }))
      .toThrow(/skipTitles\[2\] is not a valid regular expression: /);
  });

  it('hands out a fresh skipTitles array, so a parsed config cannot change the raw one', () => {
    const raw = { skipTitles: ['Release$'] };
    parseInboxConfig(raw).skipTitles.push('extra');
    expect(raw.skipTitles).toEqual(['Release$']);
  });

  it('refuses a non-positive interval, by name', () => {
    expect(() => parseInboxConfig({ pollMinutes: 0 })).toThrow(/pollMinutes must be a positive number/);
    expect(() => parseInboxConfig([])).toThrow(/must be a JSON object/);
  });

  it('sends the old prepare key to its replacement rather than ignoring it', () => {
    expect(() => parseInboxConfig({ prepare: ['claude', '-p'] }))
      .toThrow(/"prepare" was replaced by the "agent" block .* put extra flags in agent\.extraArgs/);
  });

  it('takes the agent block, and refuses each field by name', () => {
    const agent = parseInboxConfig({
      agent: { model: 'opus', effort: 'medium', mcpAllow: ['mcp__claude_ai_Atlassian__getJiraIssue'], extraArgs: ['--verbose'], maxBudgetUsd: 4.5 },
    }).agent;
    expect(agent).toEqual({
      model: 'opus', effort: 'medium', mcpAllow: ['mcp__claude_ai_Atlassian__getJiraIssue'], extraArgs: ['--verbose'], maxBudgetUsd: 4.5,
    });
    // An explicit null is the default, not a type error.
    expect(parseInboxConfig({ agent: { model: null, effort: null, maxBudgetUsd: null } }).agent).toEqual(DEFAULT_INBOX_CONFIG.agent);

    expect(() => parseInboxConfig({ agent: [] })).toThrow(/agent must be a JSON object/);
    expect(() => parseInboxConfig({ agent: { model: '' } })).toThrow(/agent\.model must be a non-empty string/);
    expect(() => parseInboxConfig({ agent: { effort: 'sometimes' } })).toThrow(/agent\.effort must be one of low\|medium\|high\|xhigh\|max/);
    expect(() => parseInboxConfig({ agent: { mcpAllow: ['Bash'] } })).toThrow(/agent\.mcpAllow must be an array of exact MCP tool names/);
    expect(() => parseInboxConfig({ agent: { mcpAllow: ['mcp__server'] } })).toThrow(/agent\.mcpAllow/);
    expect(() => parseInboxConfig({ agent: { extraArgs: [''] } })).toThrow(/agent\.extraArgs must be an array of non-empty strings/);
    expect(() => parseInboxConfig({ agent: { maxBudgetUsd: 0 } })).toThrow(/agent\.maxBudgetUsd must be a positive number/);
  });

  it('takes the validate block, and refuses each field by name', () => {
    expect(parseInboxConfig({}).validate).toEqual({ model: null, timeoutMinutes: 15, maxBudgetUsd: null });
    expect(parseInboxConfig({ validate: { model: 'opus', timeoutMinutes: 20, maxBudgetUsd: 3 } }).validate)
      .toEqual({ model: 'opus', timeoutMinutes: 20, maxBudgetUsd: 3 });
    // An explicit null is off and uncapped, not a type error.
    expect(parseInboxConfig({ validate: { model: null, maxBudgetUsd: null } }).validate).toEqual(DEFAULT_INBOX_CONFIG.validate);

    expect(() => parseInboxConfig({ validate: [] })).toThrow(/validate must be a JSON object/);
    expect(() => parseInboxConfig({ validate: { model: '' } })).toThrow(/validate\.model must be a non-empty string/);
    expect(() => parseInboxConfig({ validate: { timeoutMinutes: 0 } })).toThrow(/validate\.timeoutMinutes must be a positive number/);
    expect(() => parseInboxConfig({ validate: { maxBudgetUsd: 0 } })).toThrow(/validate\.maxBudgetUsd must be a positive number/);
  });

  it('hands out a fresh validate block, so one parsed config cannot change another', () => {
    parseInboxConfig({}).validate.model = 'opus';
    expect(parseInboxConfig({}).validate.model).toBeNull();
    expect(DEFAULT_INBOX_CONFIG.validate.model).toBeNull();
  });

  it('hands out a fresh agent block, so one parsed config cannot change another', () => {
    const first = parseInboxConfig({});
    first.agent.mcpAllow.push('mcp__a__b');
    expect(parseInboxConfig({}).agent.mcpAllow).toEqual([]);
    expect(DEFAULT_INBOX_CONFIG.agent.mcpAllow).toEqual([]);
  });

  it('takes alertWhen as a string', () => {
    expect(parseInboxConfig({}).alertWhen).toBe('');
    expect(parseInboxConfig({ alertWhen: 'a P1' }).alertWhen).toBe('a P1');
    expect(() => parseInboxConfig({ alertWhen: 3 })).toThrow(/alertWhen must be a string/);
  });

  it('saves the page settings into the file and leaves the other keys alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffity-settings-'));
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ port: 5399, filter: 'old', pollMinutes: 2 }, null, 2));
      const settings = {
        filter: 'skip payments', skipTitles: ['\\(payments\\)'], alertWhen: 'a P1', alertPaths: ['packages/shared/**'], maxPrepared: 3, pollMinutes: 7,
        live: false, liveTimeoutMinutes: 4, prepareTimeoutMinutes: 20, waitForCi: true,
        agent: { model: 'opus', effort: 'high', mcpAllow: [], extraArgs: [], maxBudgetUsd: null },
        validate: { model: null, timeoutMinutes: 15, maxBudgetUsd: null },
      };
      saveInboxSettings(path, settings);
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      expect(raw).toEqual({ port: 5399, ...settings });
      expect(parseInboxConfig(raw).port).toBe(5399);

      saveInboxSettings(join(dir, 'fresh', 'config.json'), settings);
      expect(JSON.parse(readFileSync(join(dir, 'fresh', 'config.json'), 'utf-8'))).toEqual(settings);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes live as a boolean and liveTimeoutMinutes as a positive number', () => {
    expect(parseInboxConfig({}).live).toBe(true);
    expect(parseInboxConfig({ live: false }).live).toBe(false);
    expect(parseInboxConfig({ liveTimeoutMinutes: 3 }).liveTimeoutMinutes).toBe(3);
    expect(() => parseInboxConfig({ live: 'yes' })).toThrow(/live must be true or false/);
    expect(() => parseInboxConfig({ liveTimeoutMinutes: 0 })).toThrow(/liveTimeoutMinutes must be a positive number/);
  });

  it('takes maxPrepared as a positive integer only', () => {
    expect(parseInboxConfig({}).maxPrepared).toBe(5);
    expect(parseInboxConfig({ maxPrepared: 2 }).maxPrepared).toBe(2);
    expect(() => parseInboxConfig({ maxPrepared: 0 })).toThrow(/maxPrepared must be a positive integer/);
    expect(() => parseInboxConfig({ maxPrepared: 2.5 })).toThrow(/maxPrepared must be a positive integer/);
  });
});

describe('composePrompt', () => {
  const snapshot: PrSnapshot = {
    owner: 'o', repo: 'r', number: 7, title: 'Add a widget', url: 'https://github.com/o/r/pull/7',
    author: 'alice', isBot: false, isDraft: false, state: 'OPEN', headSha: 'abc', baseRef: 'main',
    additions: 12, deletions: 3, changedFiles: 2, createdAt: '2026-09-02T10:00:00Z', updatedAt: '2026-09-02T10:00:00Z',
    checks: [], files: [],
  };

  it('tells the agent the worktree, forbids the forge, and asks for a verdict', () => {
    const prompt = composePrompt({ snapshot, worktreePath: '/wt', port: 5555, filter: '', alertWhen: '', mcpAllow: [] });
    expect(prompt).toContain('--repo /wt');
    expect(prompt).toContain('port 5555');
    expect(prompt).toContain('NOTHING you do may reach GitHub');
    expect(prompt).toContain('PREPARED');
    expect(prompt).not.toContain('SKIP:');
  });

  it('includes the reviewer\'s filter and the skip verdict when a filter is set', () => {
    const prompt = composePrompt({ snapshot, worktreePath: '/wt', port: 5555, filter: 'Skip payments-focused PRs', alertWhen: '', mcpAllow: [] });
    expect(prompt).toContain('Skip payments-focused PRs');
    expect(prompt).toContain('SKIP: <short reason>');
  });

  it('points at the review instructions in the system prompt rather than an installed skill', () => {
    const prompt = composePrompt({ snapshot, worktreePath: '/wt', port: 5555, filter: '', alertWhen: '', mcpAllow: [] });
    expect(prompt).toContain('following the review instructions in your system prompt (the');
    expect(prompt).toContain('diffity-review skill)');
  });

  it('names the allowed MCP tools, and says nothing about them when there are none', () => {
    const none = composePrompt({ snapshot, worktreePath: '/wt', port: 5555, filter: '', alertWhen: '', mcpAllow: [] });
    expect(none).not.toContain('You may use these tools');

    const some = composePrompt({
      snapshot, worktreePath: '/wt', port: 5555, filter: '', alertWhen: '',
      mcpAllow: ['mcp__claude_ai_Atlassian__getJiraIssue', 'mcp__claude_ai_Slack__slack_read_thread'],
    });
    expect(some).toContain('You may use these tools to read material the pull request refers to');
    expect(some).toContain('  mcp__claude_ai_Atlassian__getJiraIssue\n  mcp__claude_ai_Slack__slack_read_thread');
    expect(some).toContain('Nothing else outside this checkout.');
  });

  it('reports what CI made of the head and tells the agent not to redo its work', () => {
    const prompt = composePrompt({
      snapshot: {
        ...snapshot,
        checks: [
          { name: 'check-job', status: 'success' },
          { name: 'pr-ecosystem-test (admin3)', status: 'success' },
          { name: 'e2e', status: 'pending' },
          { name: 'integration-test-job', status: 'skipped' },
          { name: 'ncapp3-playwright-e2e-tests-job', status: 'skipped' },
        ],
      },
      worktreePath: '/wt', port: 5555, filter: '', alertWhen: '', mcpAllow: [],
    });
    expect(prompt).toContain('CI at this head: check-job SUCCESS \u00b7 pr-ecosystem-test (admin3) SUCCESS \u00b7 e2e PENDING \u00b7 2 more skipped');
    expect(prompt).toContain('Do not install dependencies, build, typecheck, lint or run tests');
    expect(prompt).toContain('If a check failed or is still running,\nsay so in the summary.');
  });

  it('says so plainly when every check was skipped', () => {
    const prompt = composePrompt({
      snapshot: { ...snapshot, checks: [{ name: 'a', status: 'skipped' }, { name: 'b', status: 'skipped' }] },
      worktreePath: '/wt', port: 5555, filter: '', alertWhen: '', mcpAllow: [],
    });
    expect(prompt).toContain('CI at this head: 2 checks skipped, none ran');
  });

  it('says CI has not reported when nothing has, and still forbids the toolchain', () => {
    const prompt = composePrompt({ snapshot, worktreePath: '/wt', port: 5555, filter: '', alertWhen: '', mcpAllow: [] });
    expect(prompt).toContain('CI has not reported for this head.');
    expect(prompt).toContain('Do not install dependencies, build, typecheck, lint or run tests');
  });

  it('holds a check name to one line and a length, as it does the author\'s other text', () => {
    const name = `pr-feature-branch / ${'x'.repeat(200)}`;
    const prompt = composePrompt({
      snapshot: { ...snapshot, checks: [{ name: `deploy\n${name}`, status: 'failure' }] },
      worktreePath: '/wt', port: 5555, filter: '', alertWhen: '', mcpAllow: [],
    });
    const line = prompt.split('\n').find(l => l.startsWith('CI at this head:'))!;
    expect(line).toBe(`CI at this head: ${`deploy ${name}`.slice(0, 80)} FAILURE`);
  });
});

describe('composePrompt alerts', () => {
  const snapshot: PrSnapshot = {
    owner: 'o', repo: 'r', number: 7, title: 'Add a widget', url: 'https://github.com/o/r/pull/7',
    author: 'alice', isBot: false, isDraft: false, state: 'OPEN', headSha: 'abc', baseRef: 'main',
    additions: 12, deletions: 3, changedFiles: 2, createdAt: '2026-09-02T10:00:00Z', updatedAt: '2026-09-02T10:00:00Z',
    checks: [], files: [],
  };

  it('asks for an ALERT line, and the findings behind it, only when the reviewer said what matters', () => {
    const quiet = composePrompt({ snapshot, worktreePath: '/wt', port: 5555, filter: '', alertWhen: '', mcpAllow: [] });
    expect(quiet).not.toContain('ALERT:');
    expect(quiet).not.toContain('ALERT-FINDINGS');
    const loud = composePrompt({ snapshot, worktreePath: '/wt', port: 5555, filter: '', alertWhen: 'there is a P1', mcpAllow: [] });
    expect(loud).toContain('  there is a P1');
    expect(loud).toContain('ALERT: <short reason>');
    expect(loud).toContain('ALERT-FINDINGS: <thread id> <thread id>');
    // The ids to name are the ones the agent has already been given, once per finding it left.
    expect(loud).toContain('Created thread cf15e689');
    expect(loud.trim().endsWith('PREPARED')).toBe(true);
  });
});

describe('summarizeFindings', () => {
  const c = (body: string, kind: 'review' | 'aside' = 'review') => ({ body, kind, author: { name: 'Agent', type: 'agent' as const }, createdAt: '' });
  const open = (filePath: string, ...comments: ReturnType<typeof c>[]) => ({ filePath, status: 'open' as const, comments });

  it('counts finding threads by the severity they open with, in order, leaving the summary out', () => {
    expect(summarizeFindings([
      open('a.ts', c('P2: one'), c('reply', 'aside')),
      open('b.ts', c('P1: two')),
      open('c.ts', c('p2: lower case counts')),
      open('d.ts', c('[must-fix] old vocabulary')),
      open('e.ts', c('no label at all')),
      open('__general__', c('Overall fine.')),
    ])).toBe('1 P1 \u00b7 2 P2 \u00b7 1 must-fix \u00b7 1 other');
    expect(summarizeFindings([open('__general__', c('Nothing found.'))])).toBe('no findings');
    expect(severityOf('  P3: nit')).toBe('P3');
    expect(severityOf('[question] why?')).toBe('question');
  });

  it('leaves out a finding the checking pass settled, so the card counts only what is left', () => {
    expect(summarizeFindings([
      { filePath: 'a.ts', status: 'dismissed', comments: [c('P1: this does not hold')] },
      { filePath: 'b.ts', status: 'resolved', comments: [c('P2: already answered')] },
      open('c.ts', c('P3: a nit')),
    ])).toBe('1 P3');

    expect(summarizeFindings([
      { filePath: 'a.ts', status: 'dismissed', comments: [c('P1: this does not hold')] },
      { filePath: 'b.ts', status: 'dismissed', comments: [c('P2: nor this')] },
    ])).toBe('no findings');
  });
});

describe('parseSettingsPatch', () => {
  const full = {
    filter: 'a', skipTitles: ['Release$'], alertWhen: 'b', alertPaths: ['src/**'], maxPrepared: 2, pollMinutes: 3, live: false,
    liveTimeoutMinutes: 5, prepareTimeoutMinutes: 15, waitForCi: false,
    agent: { model: null, effort: null, mcpAllow: [], extraArgs: [], maxBudgetUsd: null },
    validate: { model: null, timeoutMinutes: 15, maxBudgetUsd: null },
  };
  it('takes every editable key, validated as the config file is, and refuses anything else by name', () => {
    expect(parseSettingsPatch(JSON.stringify(full))).toEqual({ ok: true, settings: full });
    expect(parseSettingsPatch(JSON.stringify({ ...full, alertWhen: undefined }))).toMatchObject({ ok: false, message: 'alertWhen is missing' });
    expect(parseSettingsPatch(JSON.stringify({ ...full, agent: undefined }))).toMatchObject({ ok: false, message: 'agent is missing' });
    expect(parseSettingsPatch(JSON.stringify({ ...full, maxPrepared: 0 }))).toMatchObject({ ok: false, message: 'maxPrepared must be a positive integer' });
    expect(parseSettingsPatch(JSON.stringify({ ...full, live: 'yes' }))).toMatchObject({ ok: false, message: 'live must be true or false' });
    expect(parseSettingsPatch(JSON.stringify({ ...full, filter: 'x'.repeat(5000) }))).toMatchObject({ ok: false });
    expect(parseSettingsPatch('nope')).toMatchObject({ ok: false });
    expect(parseSettingsPatch('[]')).toMatchObject({ ok: false });
  });

  it('round-trips the title patterns and refuses one that does not compile', () => {
    const edited = { ...full, skipTitles: ['\\(payments\\)', 'Release$'] };
    expect(parseSettingsPatch(JSON.stringify(edited))).toEqual({ ok: true, settings: edited });
    expect(parseSettingsPatch(JSON.stringify({ ...full, skipTitles: undefined })))
      .toMatchObject({ ok: false, message: 'skipTitles is missing' });
    expect(parseSettingsPatch(JSON.stringify({ ...full, skipTitles: ['ok', '(payments'] })))
      .toMatchObject({ ok: false, message: expect.stringContaining('skipTitles[1] is not a valid regular expression') });
  });

  it('takes the validate fields the page edits and refuses a bad one by name', () => {
    const edited = { ...full, validate: { model: 'opus', timeoutMinutes: 20, maxBudgetUsd: 3 } };
    expect(parseSettingsPatch(JSON.stringify(edited))).toEqual({ ok: true, settings: edited });
    expect(parseSettingsPatch(JSON.stringify({ ...full, validate: undefined })))
      .toMatchObject({ ok: false, message: 'validate is missing' });
    expect(parseSettingsPatch(JSON.stringify({ ...full, validate: { ...full.validate, timeoutMinutes: 0 } })))
      .toMatchObject({ ok: false, message: 'validate.timeoutMinutes must be a positive number' });
  });

  it('takes the agent fields the page edits and refuses a bad one by name', () => {
    const edited = { ...full, agent: { model: 'opus', effort: 'high', mcpAllow: ['mcp__slack__slack_read_thread'], extraArgs: ['--verbose'], maxBudgetUsd: 2 } };
    expect(parseSettingsPatch(JSON.stringify(edited))).toEqual({ ok: true, settings: edited });
    expect(parseSettingsPatch(JSON.stringify({ ...full, agent: { ...full.agent, effort: 'later' } })))
      .toMatchObject({ ok: false, message: 'agent.effort must be one of low|medium|high|xhigh|max' });
    expect(parseSettingsPatch(JSON.stringify({ ...full, agent: { ...full.agent, mcpAllow: ['gcloud'] } })))
      .toMatchObject({ ok: false, message: 'agent.mcpAllow must be an array of exact MCP tool names, like mcp__server__tool' });
  });
});

describe('verdictOf', () => {
  it('reads PREPARED, SKIP with a reason, and neither', () => {
    expect(verdictOf('working...\nPREPARED\n')).toEqual({ kind: 'prepared', alert: null, alertFindings: [] });
    expect(verdictOf('working...\nALERT: touches auth\nPREPARED\n')).toEqual({ kind: 'prepared', alert: 'touches auth', alertFindings: [] });
    expect(verdictOf('ALERT: early\nSKIP: payments PR\n')).toEqual({ kind: 'skipped', reason: 'payments PR' });
    expect(verdictOf('looking\nSKIP: payments PR\n')).toEqual({ kind: 'skipped', reason: 'payments PR' });
    expect(verdictOf('done thinking\n')).toEqual({ kind: 'none' });
  });

  it('takes the last verdict, so echoed instructions do not pre-empt the real one', () => {
    expect(verdictOf('I will print SKIP: x or PREPARED.\nreviewing\nPREPARED')).toEqual({ kind: 'prepared', alert: null, alertFindings: [] });
  });

  it('defaults a reasonless skip rather than reading an empty reason', () => {
    expect(verdictOf('SKIP:')).toEqual({ kind: 'skipped', reason: 'no reason given' });
  });

  it('reads the findings behind an alert, as printed ids or full uuids, spaced or comma-separated', () => {
    expect(verdictOf('ALERT: a P1 in payments\nALERT-FINDINGS: cf15e689 7b2a10c4\nPREPARED'))
      .toEqual({ kind: 'prepared', alert: 'a P1 in payments', alertFindings: ['cf15e689', '7b2a10c4'] });
    expect(verdictOf('ALERT: x\nALERT-FINDINGS: cf15e689-1c3d-4a1f-8b21-0123456789ab, 7b2a10c4\nPREPARED'))
      .toEqual({ kind: 'prepared', alert: 'x', alertFindings: ['cf15e689-1c3d-4a1f-8b21-0123456789ab', '7b2a10c4'] });
    // The line can come before the reason it belongs to.
    expect(verdictOf('ALERT-FINDINGS: cf15e689\nALERT: x\nPREPARED'))
      .toEqual({ kind: 'prepared', alert: 'x', alertFindings: ['cf15e689'] });
  });

  it('names each finding once, whatever case it was printed in, and nothing that is not an id', () => {
    expect(verdictOf('ALERT: x\nALERT-FINDINGS: CF15E689 cf15e689 the-P1 cf15, 7b2a10c4\nPREPARED'))
      .toEqual({ kind: 'prepared', alert: 'x', alertFindings: ['cf15e689', '7b2a10c4'] });
    expect(verdictOf('ALERT: x\nALERT-FINDINGS:\nPREPARED'))
      .toEqual({ kind: 'prepared', alert: 'x', alertFindings: [] });
  });

  it('ignores findings nobody raised an alert for, and takes the last of each line', () => {
    expect(verdictOf('ALERT-FINDINGS: cf15e689\nPREPARED'))
      .toEqual({ kind: 'prepared', alert: null, alertFindings: [] });
    expect(verdictOf('ALERT: first\nALERT-FINDINGS: aaaaaaaa\nALERT: second\nALERT-FINDINGS: bbbbbbbb\nPREPARED'))
      .toEqual({ kind: 'prepared', alert: 'second', alertFindings: ['bbbbbbbb'] });
  });
});

describe('the forge parsers', () => {
  it('reads owner/repo/number out of a search result and drops malformed rows', () => {
    const json = JSON.stringify([
      { repository: { nameWithOwner: 'o/r' }, number: 3 },
      { repository: { nameWithOwner: 'bad' }, number: 4 },
      { number: 5 },
    ]);
    expect(parseReviewRequested(json)).toEqual([{ owner: 'o', repo: 'r', number: 3 }]);
  });

  it('reads a snapshot and rejects one missing its head', () => {
    const ref = { owner: 'o', repo: 'r', number: 1 };
    const ok = parsePrSnapshot(ref, JSON.stringify({
      title: 'T', url: 'https://github.com/o/r/pull/1', author: { login: 'alice', is_bot: false },
      isDraft: false, state: 'OPEN', headRefOid: 'abc', baseRefName: 'main', additions: 1, deletions: 0, changedFiles: 1, createdAt: 'now', updatedAt: 'now',
    }));
    expect(ok?.headSha).toBe('abc');
    expect(ok?.state).toBe('OPEN');
    expect(ok?.createdAt).toBe('now');

    const bad = parsePrSnapshot(ref, JSON.stringify({ url: 'u', state: 'OPEN' }));
    expect(bad).toBeNull();
  });
});
