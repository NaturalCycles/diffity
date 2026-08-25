import { describe, it, expect } from 'vitest';
import { pullOutcome } from '../src/lib/pull-outcome';

describe('pullOutcome', () => {
  it('reports what came back', () => {
    expect(pullOutcome({ pulled: 2, skipped: 0, resolved: 0 }).message).toBe('Pulled 2 comments');
    expect(pullOutcome({ pulled: 1, skipped: 0, resolved: 0 }).message).toBe('Pulled 1 comment');
  });

  // The reason this is not folded into the pulled count: nothing arrived, but something changed.
  it('reports resolutions on their own, and asks for a refresh', () => {
    const outcome = pullOutcome({ pulled: 0, skipped: 4, resolved: 1 });

    expect(outcome.message).toBe('1 finding resolved on the pull request');
    expect(outcome.refresh).toBe(true);
    expect(outcome.kind).toBe('success');
  });

  it('reports both together', () => {
    expect(pullOutcome({ pulled: 2, skipped: 1, resolved: 3 }).message)
      .toBe('Pulled 2 comments, 3 findings resolved on the pull request');
  });

  it('does not ask for a refresh when nothing changed', () => {
    const outcome = pullOutcome({ pulled: 0, skipped: 5, resolved: 0 });

    expect(outcome.refresh).toBe(false);
    expect(outcome.kind).toBe('info');
    expect(outcome.message).toBe('Nothing new — every comment is already here');
  });

  it('has something to say when the pull request had nothing at all', () => {
    expect(pullOutcome({ pulled: 0, skipped: 0, resolved: 0 }).message).toBe('Nothing to pull');
  });
});

describe('when the forge could not be asked about resolution', () => {
  it('says so rather than implying nothing was resolved', () => {
    const outcome = pullOutcome({ pulled: 0, skipped: 3, resolved: 0, resolutionUnavailable: true });

    expect(outcome.message).toBe('could not read which are resolved');
    expect(outcome.kind).toBe('info');
    expect(outcome.refresh).toBe(false);
  });

  it('still reports what did arrive', () => {
    expect(pullOutcome({ pulled: 2, skipped: 0, resolved: 0, resolutionUnavailable: true }).message)
      .toBe('Pulled 2 comments, could not read which are resolved');
  });
});
