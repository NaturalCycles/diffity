import { describe, it, expect } from 'vitest';
import { unreadAlerts } from '../src/lib/answer-alerts';
import type { AnswerAlert } from '../src/lib/answer-alerts';

const alert = (threadId: string): AnswerAlert =>
  ({ threadId, filePath: 'src/a.ts', preview: 'an answer' }) as AnswerAlert;

describe('unreadAlerts', () => {
  it('counts a note that is still on screen', () => {
    expect(unreadAlerts([alert('a')], []).map(a => a.threadId)).toEqual(['a']);
  });

  it('counts one whose time has run out', () => {
    expect(unreadAlerts([], [alert('a')]).map(a => a.threadId)).toEqual(['a']);
  });

  // The bug this is for: a note moves from shown to expired, and the count must not budge, because
  // nothing happened that the reader did not already know about.
  it('does not change when a note stops being shown', () => {
    const shown = unreadAlerts([alert('a'), alert('b')], []);
    const afterExpiry = unreadAlerts([], [alert('a'), alert('b')]);

    expect(afterExpiry.length).toBe(shown.length);
  });

  it('counts a thread once when it is in both lists', () => {
    expect(unreadAlerts([alert('a')], [alert('a')]).length).toBe(1);
  });

  it('is empty when there is nothing unread', () => {
    expect(unreadAlerts([], [])).toEqual([]);
  });
});
