import { describe, it, expect } from 'vitest';
import { unansweredRequest } from '../src/live-unanswered.js';

const asked = { id: 'c1', liveRequestedAt: '2026-08-25T10:00:00Z', liveAnsweredAt: null };
const answered = { id: 'c2', liveRequestedAt: '2026-08-25T10:00:00Z', liveAnsweredAt: '2026-08-25T10:05:00Z' };
const plain = { id: 'c3' };

describe('unansweredRequest', () => {
  it('finds a request nobody has closed', () => {
    expect(unansweredRequest([plain, asked])).toBe('c1');
  });

  it('ignores one that was answered', () => {
    expect(unansweredRequest([plain, answered])).toBeNull();
  });

  it('ignores comments that never asked for anything', () => {
    expect(unansweredRequest([plain, plain])).toBeNull();
  });

  it('is empty on an empty thread', () => {
    expect(unansweredRequest([])).toBeNull();
  });
});
