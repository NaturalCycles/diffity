import { describe, it, expect } from 'vitest';
import { parseReviews } from '../src/reviews.js';

const raw = JSON.stringify([
  {
    user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
    state: 'COMMENTED',
    body: '## Pull request overview\n\nUpdates the experiment form.',
    submitted_at: '2026-08-21T11:54:36Z',
  },
  {
    user: { login: 'fiddur', type: 'User' },
    state: 'APPROVED',
    body: 'lgtm',
    submitted_at: '2026-08-21T12:11:34Z',
  },
  {
    user: { login: 'someone', type: 'User' },
    state: 'COMMENTED',
    body: '',
    submitted_at: '2026-08-21T12:20:00Z',
  },
]);

describe('parseReviews', () => {
  it('keeps author, state, body and time, newest last', () => {
    const reviews = parseReviews(raw);

    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toEqual({
      author: 'copilot-pull-request-reviewer[bot]',
      isBot: true,
      state: 'COMMENTED',
      body: '## Pull request overview\n\nUpdates the experiment form.',
      submittedAt: '2026-08-21T11:54:36Z',
    });
    expect(reviews[1].author).toBe('fiddur');
    expect(reviews[1].state).toBe('APPROVED');
  });

  it('drops a review with nothing to read', () => {
    // A bodiless COMMENTED review is what the forge records for inline-only comments; the inline
    // comments themselves come through the existing pull, so there is nothing to show here.
    expect(parseReviews(raw).some(review => review.author === 'someone')).toBe(false);
  });

  it('keeps a bodiless approval, because the verdict is the content', () => {
    const approvals = JSON.stringify([
      { user: { login: 'a', type: 'User' }, state: 'APPROVED', body: '', submitted_at: '2026-01-01T00:00:00Z' },
      { user: { login: 'b', type: 'User' }, state: 'CHANGES_REQUESTED', body: '', submitted_at: '2026-01-02T00:00:00Z' },
    ]);

    expect(parseReviews(approvals).map(r => r.state)).toEqual(['APPROVED', 'CHANGES_REQUESTED']);
  });

  it('survives junk rather than failing the page', () => {
    expect(parseReviews('not json')).toEqual([]);
    expect(parseReviews('{}')).toEqual([]);
    expect(parseReviews('[]')).toEqual([]);
  });
});
