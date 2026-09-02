import { describe, it, expect } from 'vitest';
import { parseInboxConfig, DEFAULT_INBOX_CONFIG } from '../src/inbox/config.js';
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
});

describe('composePrompt', () => {
  const snapshot: PrSnapshot = {
    owner: 'o', repo: 'r', number: 7, title: 'Add a widget', url: 'https://github.com/o/r/pull/7',
    author: 'alice', isBot: false, isDraft: false, state: 'OPEN', headSha: 'abc', baseRef: 'main',
    additions: 12, deletions: 3, changedFiles: 2, updatedAt: '2026-09-02T10:00:00Z',
  };

  it('tells the agent the worktree, forbids the forge, and asks for a verdict', () => {
    const prompt = composePrompt({ snapshot, worktreePath: '/wt', port: 5555, filter: '' });
    expect(prompt).toContain('--repo /wt');
    expect(prompt).toContain('port 5555');
    expect(prompt).toContain('NOTHING you do may reach GitHub');
    expect(prompt).toContain('PREPARED');
    expect(prompt).not.toContain('SKIP:');
  });

  it('includes the reviewer\'s filter and the skip verdict when a filter is set', () => {
    const prompt = composePrompt({ snapshot, worktreePath: '/wt', port: 5555, filter: 'Skip payments-focused PRs' });
    expect(prompt).toContain('Skip payments-focused PRs');
    expect(prompt).toContain('SKIP: <short reason>');
  });
});

describe('verdictOf', () => {
  it('reads PREPARED, SKIP with a reason, and neither', () => {
    expect(verdictOf('working...\nPREPARED\n')).toEqual({ kind: 'prepared' });
    expect(verdictOf('looking\nSKIP: payments PR\n')).toEqual({ kind: 'skipped', reason: 'payments PR' });
    expect(verdictOf('done thinking\n')).toEqual({ kind: 'none' });
  });

  it('takes the last verdict, so echoed instructions do not pre-empt the real one', () => {
    expect(verdictOf('I will print SKIP: x or PREPARED.\nreviewing\nPREPARED')).toEqual({ kind: 'prepared' });
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
      isDraft: false, state: 'OPEN', headRefOid: 'abc', baseRefName: 'main', additions: 1, deletions: 0, changedFiles: 1, updatedAt: 'now',
    }));
    expect(ok?.headSha).toBe('abc');
    expect(ok?.state).toBe('OPEN');

    const bad = parsePrSnapshot(ref, JSON.stringify({ url: 'u', state: 'OPEN' }));
    expect(bad).toBeNull();
  });
});
