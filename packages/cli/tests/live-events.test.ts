import { describe, it, expect } from 'vitest';
import { sinceLastWait, describeSince } from '../src/live-events.js';

const t = (s: string) => `2026-08-26 12:${s}:00`;

describe('sinceLastWait', () => {
  it('counts what went out after the agent last looked', () => {
    expect(sinceLastWait([t('05'), t('15')], t('10')).submitted).toBe(1);
  });

  it('counts nothing when nothing went out', () => {
    expect(sinceLastWait([null, null], t('10')).submitted).toBe(0);
  });

  // First wait of a session: everything already sent is news, because the agent has not looked yet.
  it('counts everything when the agent has never looked', () => {
    expect(sinceLastWait([t('05'), t('15')], null).submitted).toBe(2);
  });

  it('does not count something sent at the exact moment it looked', () => {
    expect(sinceLastWait([t('10')], t('10')).submitted).toBe(0);
  });
});

describe('describeSince', () => {
  it('says nothing when nothing happened', () => {
    expect(describeSince({ submitted: 0 })).toBeNull();
  });

  it('warns about amending, which is the reason this matters', () => {
    expect(describeSince({ submitted: 1 })).toContain('1 finding went to the pull request');
    expect(describeSince({ submitted: 1 })).toContain('old wording');
    expect(describeSince({ submitted: 3 })).toContain('3 findings');
  });
});
