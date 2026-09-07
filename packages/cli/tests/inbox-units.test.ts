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
    expect(config.prepare).toEqual(DEFAULT_INBOX_CONFIG.prepare);
  });

  it('refuses a non-positive interval and an empty prepare command, by name', () => {
    expect(() => parseInboxConfig({ pollMinutes: 0 })).toThrow(/pollMinutes must be a positive number/);
    expect(() => parseInboxConfig({ prepare: [] })).toThrow(/prepare must be a non-empty array/);
    expect(() => parseInboxConfig({ prepare: ['claude', 42] })).toThrow(/prepare must be a non-empty array/);
    expect(() => parseInboxConfig([])).toThrow(/must be a JSON object/);
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
      const settings = { filter: 'skip payments', alertWhen: 'a P1', maxPrepared: 3, pollMinutes: 7, live: false, liveTimeoutMinutes: 4, prepareTimeoutMinutes: 20 };
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
  };

  it('tells the agent the worktree, forbids the forge, and asks for a verdict', () => {
    const prompt = composePrompt({ snapshot, worktreePath: '/wt', port: 5555, filter: '', alertWhen: '' });
    expect(prompt).toContain('--repo /wt');
    expect(prompt).toContain('port 5555');
    expect(prompt).toContain('NOTHING you do may reach GitHub');
    expect(prompt).toContain('PREPARED');
    expect(prompt).not.toContain('SKIP:');
  });

  it('includes the reviewer\'s filter and the skip verdict when a filter is set', () => {
    const prompt = composePrompt({ snapshot, worktreePath: '/wt', port: 5555, filter: 'Skip payments-focused PRs', alertWhen: '' });
    expect(prompt).toContain('Skip payments-focused PRs');
    expect(prompt).toContain('SKIP: <short reason>');
  });
});

describe('composePrompt alerts', () => {
  const snapshot: PrSnapshot = {
    owner: 'o', repo: 'r', number: 7, title: 'Add a widget', url: 'https://github.com/o/r/pull/7',
    author: 'alice', isBot: false, isDraft: false, state: 'OPEN', headSha: 'abc', baseRef: 'main',
    additions: 12, deletions: 3, changedFiles: 2, createdAt: '2026-09-02T10:00:00Z', updatedAt: '2026-09-02T10:00:00Z',
  };

  it('asks for an ALERT line only when the reviewer said what matters', () => {
    const quiet = composePrompt({ snapshot, worktreePath: '/wt', port: 5555, filter: '', alertWhen: '' });
    expect(quiet).not.toContain('ALERT:');
    const loud = composePrompt({ snapshot, worktreePath: '/wt', port: 5555, filter: '', alertWhen: 'there is a P1' });
    expect(loud).toContain('  there is a P1');
    expect(loud).toContain('ALERT: <short reason>');
    expect(loud.trim().endsWith('PREPARED')).toBe(true);
  });
});

describe('summarizeFindings', () => {
  const c = (body: string, kind: 'review' | 'aside' = 'review') => ({ body, kind, author: { name: 'Agent', type: 'agent' as const }, createdAt: '' });
  it('counts finding threads by the severity they open with, in order, leaving the summary out', () => {
    expect(summarizeFindings([
      { filePath: 'a.ts', comments: [c('P2: one'), c('reply', 'aside')] },
      { filePath: 'b.ts', comments: [c('P1: two')] },
      { filePath: 'c.ts', comments: [c('p2: lower case counts')] },
      { filePath: 'd.ts', comments: [c('[must-fix] old vocabulary')] },
      { filePath: 'e.ts', comments: [c('no label at all')] },
      { filePath: '__general__', comments: [c('Overall fine.')] },
    ])).toBe('1 P1 \u00b7 2 P2 \u00b7 1 must-fix \u00b7 1 other');
    expect(summarizeFindings([{ filePath: '__general__', comments: [c('Nothing found.')] }])).toBe('no findings');
    expect(severityOf('  P3: nit')).toBe('P3');
    expect(severityOf('[question] why?')).toBe('question');
  });
});

describe('parseSettingsPatch', () => {
  const full = { filter: 'a', alertWhen: 'b', maxPrepared: 2, pollMinutes: 3, live: false, liveTimeoutMinutes: 5, prepareTimeoutMinutes: 15 };
  it('takes every editable key, validated as the config file is, and refuses anything else by name', () => {
    expect(parseSettingsPatch(JSON.stringify(full))).toEqual({ ok: true, settings: full });
    expect(parseSettingsPatch(JSON.stringify({ ...full, alertWhen: undefined }))).toMatchObject({ ok: false, message: 'alertWhen is missing' });
    expect(parseSettingsPatch(JSON.stringify({ ...full, maxPrepared: 0 }))).toMatchObject({ ok: false, message: 'maxPrepared must be a positive integer' });
    expect(parseSettingsPatch(JSON.stringify({ ...full, live: 'yes' }))).toMatchObject({ ok: false, message: 'live must be true or false' });
    expect(parseSettingsPatch(JSON.stringify({ ...full, filter: 'x'.repeat(5000) }))).toMatchObject({ ok: false });
    expect(parseSettingsPatch('nope')).toMatchObject({ ok: false });
    expect(parseSettingsPatch('[]')).toMatchObject({ ok: false });
  });
});

describe('verdictOf', () => {
  it('reads PREPARED, SKIP with a reason, and neither', () => {
    expect(verdictOf('working...\nPREPARED\n')).toEqual({ kind: 'prepared', alert: null });
    expect(verdictOf('working...\nALERT: touches auth\nPREPARED\n')).toEqual({ kind: 'prepared', alert: 'touches auth' });
    expect(verdictOf('ALERT: early\nSKIP: payments PR\n')).toEqual({ kind: 'skipped', reason: 'payments PR' });
    expect(verdictOf('looking\nSKIP: payments PR\n')).toEqual({ kind: 'skipped', reason: 'payments PR' });
    expect(verdictOf('done thinking\n')).toEqual({ kind: 'none' });
  });

  it('takes the last verdict, so echoed instructions do not pre-empt the real one', () => {
    expect(verdictOf('I will print SKIP: x or PREPARED.\nreviewing\nPREPARED')).toEqual({ kind: 'prepared', alert: null });
  });

  it('defaults a reasonless skip rather than reading an empty reason', () => {
    expect(verdictOf('SKIP:')).toEqual({ kind: 'skipped', reason: 'no reason given' });
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
