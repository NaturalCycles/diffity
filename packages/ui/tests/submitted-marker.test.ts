import { describe, it, expect } from 'vitest';
import { submittedLabel, localResolveNotice } from '../src/lib/submitted-marker';

const now = new Date(2026, 7, 25, 18, 4);

describe('submittedLabel', () => {
  it('says nothing for a thread that was never sent', () => {
    expect(submittedLabel(null, now)).toBeNull();
    expect(submittedLabel(undefined, now)).toBeNull();
  });

  it('gives the time for today', () => {
    expect(submittedLabel(new Date(2026, 7, 25, 15, 37).toISOString(), now))
      .toBe('Posted to GitHub 15:37');
  });

  it('names yesterday', () => {
    expect(submittedLabel(new Date(2026, 7, 24, 15, 37).toISOString(), now))
      .toBe('Posted to GitHub yesterday 15:37');
  });

  // Yesterday is a calendar day, not 24 hours: 23:50 last night is yesterday at 00:10 tonight.
  it('counts yesterday by the calendar', () => {
    expect(submittedLabel(new Date(2026, 7, 24, 23, 50).toISOString(), new Date(2026, 7, 25, 0, 10)))
      .toBe('Posted to GitHub yesterday 23:50');
  });

  it('gives a date further back, and the year once it is another one', () => {
    expect(submittedLabel(new Date(2026, 7, 12, 9, 5).toISOString(), now))
      .toBe('Posted to GitHub 12 Aug 09:05');
    expect(submittedLabel(new Date(2025, 7, 12, 9, 5).toISOString(), now))
      .toBe('Posted to GitHub 12 Aug 2025 09:05');
  });

  it('says nothing for a timestamp it cannot read', () => {
    expect(submittedLabel('not a date', now)).toBeNull();
  });
});

describe('localResolveNotice', () => {
  it('warns on a finding that was posted', () => {
    expect(localResolveNotice('2026-08-24T15:37:00Z'))
      .toBe('Resolved here only — the thread on the pull request stays open');
  });

  it('says nothing about one that was never posted, which has nowhere else to be resolved', () => {
    expect(localResolveNotice(null)).toBeNull();
    expect(localResolveNotice(undefined)).toBeNull();
  });
});
