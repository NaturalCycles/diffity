import { describe, it, expect } from 'vitest';
import { cutText, fetchPrContext, MAX_CONTEXT_BODY, parseReviewComments, type PrSnapshot } from '../src/inbox.js';

function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    owner: 'o', repo: 'r', number: 7, title: 'Add a widget', body: 'Risk Evaluation: high',
    url: 'https://github.com/o/r/pull/7', author: 'alice', isBot: false, isDraft: false, state: 'OPEN',
    headSha: 'abc', baseRef: 'main', additions: 12, deletions: 3, changedFiles: 2,
    createdAt: '2026-09-02T10:00:00Z', updatedAt: '2026-09-02T10:00:00Z', checks: [], files: [],
    ...over,
  };
}

const DISCUSSION = JSON.stringify({
  comments: [
    { author: { login: 'bob' }, createdAt: '2026-09-02T11:00:00Z', body: 'Does this need a migration?' },
    { author: { login: 'alice' }, createdAt: '2026-09-02T11:05:00Z', body: 'No, the column is new.' },
  ],
  reviews: [
    { author: { login: 'carol' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-02T12:00:00Z', body: 'See below.' },
  ],
});

/** One inline comment as the forge's REST route reports one. */
function inline(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: { login: 'carol' }, path: 'src/a.ts', line: 12, side: 'RIGHT',
    created_at: '2026-09-02T12:00:00Z', body: 'This leaks the token', in_reply_to_id: null,
    ...over,
  };
}

/** A gh that answers from fixtures and records what it was asked, so nothing reaches the forge. */
function fakeGh(pages: string[], discussion = DISCUSSION): { run: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: args => {
      calls.push(args);
      if (args[0] === 'pr') {
        return Promise.resolve(discussion);
      }
      const page = Number(/[?&]page=(\d+)/.exec(args[1] ?? '')?.[1] ?? 1);
      return Promise.resolve(pages[page - 1] ?? '[]');
    },
  };
}

describe('fetchPrContext', () => {
  it('carries the description off the snapshot and the discussion off the forge', async () => {
    const { run, calls } = fakeGh([JSON.stringify([inline(), inline({ in_reply_to_id: 90 })])]);

    const context = await fetchPrContext(snapshot(), run);

    expect(context).toEqual({
      owner: 'o', repo: 'r', number: 7, title: 'Add a widget', author: 'alice',
      url: 'https://github.com/o/r/pull/7', headSha: 'abc', baseRef: 'main',
      body: 'Risk Evaluation: high',
      comments: [
        { author: 'bob', createdAt: '2026-09-02T11:00:00Z', body: 'Does this need a migration?' },
        { author: 'alice', createdAt: '2026-09-02T11:05:00Z', body: 'No, the column is new.' },
      ],
      reviews: [
        { author: 'carol', state: 'CHANGES_REQUESTED', submittedAt: '2026-09-02T12:00:00Z', body: 'See below.' },
      ],
      reviewComments: [
        { author: 'carol', path: 'src/a.ts', line: 12, side: 'RIGHT', createdAt: '2026-09-02T12:00:00Z', body: 'This leaks the token', inReplyTo: null },
        { author: 'carol', path: 'src/a.ts', line: 12, side: 'RIGHT', createdAt: '2026-09-02T12:00:00Z', body: 'This leaks the token', inReplyTo: 90 },
      ],
    });
    expect(calls[0]).toEqual(['pr', 'view', '7', '--repo', 'o/r', '--json', 'comments,reviews']);
    expect(calls[1]).toEqual(['api', 'repos/o/r/pulls/7/comments?per_page=100&page=1']);
    // A short page is the last one: nothing is asked for beyond it.
    expect(calls).toHaveLength(2);
  });

  it('reads page after page of inline comments until one comes back short', async () => {
    const full = JSON.stringify(Array.from({ length: 100 }, () => inline()));
    const { run, calls } = fakeGh([full, full, JSON.stringify([inline()])]);

    const context = await fetchPrContext(snapshot(), run);

    expect(context.reviewComments).toHaveLength(201);
    expect(calls.map(args => args[1]).slice(1)).toEqual([
      'repos/o/r/pulls/7/comments?per_page=100&page=1',
      'repos/o/r/pulls/7/comments?per_page=100&page=2',
      'repos/o/r/pulls/7/comments?per_page=100&page=3',
    ]);
  });

  it('stops asking after ten full pages, however long the thread runs', async () => {
    const full = JSON.stringify(Array.from({ length: 100 }, () => inline()));
    const { run, calls } = fakeGh(Array.from({ length: 20 }, () => full));

    const context = await fetchPrContext(snapshot(), run);

    expect(context.reviewComments).toHaveLength(1000);
    expect(calls).toHaveLength(11);
  });

  it('cuts every body at the limit and says it did', async () => {
    const long = 'x'.repeat(MAX_CONTEXT_BODY + 500);
    const { run } = fakeGh(
      [JSON.stringify([inline({ body: long })])],
      JSON.stringify({
        comments: [{ author: { login: 'bob' }, createdAt: 'now', body: long }],
        reviews: [{ author: { login: 'carol' }, state: 'COMMENTED', submittedAt: 'now', body: long }],
      }),
    );

    const context = await fetchPrContext(snapshot({ body: long }), run);

    for (const body of [context.body, context.comments[0].body, context.reviews[0].body, context.reviewComments[0].body]) {
      expect(body).toBe(`${'x'.repeat(MAX_CONTEXT_BODY)}\n… [cut]`);
    }
  });

  it('fills in what the forge left out, and skips what is not a comment at all', async () => {
    const { run } = fakeGh(
      [JSON.stringify([{}, null, 'nonsense', inline({ line: null, user: undefined })])],
      JSON.stringify({ comments: [{}], reviews: [{}], somethingElse: 3 }),
    );

    const context = await fetchPrContext(snapshot({ body: '' }), run);

    expect(context.body).toBe('');
    expect(context.comments).toEqual([{ author: 'unknown', createdAt: '', body: '' }]);
    expect(context.reviews).toEqual([{ author: 'unknown', state: 'COMMENTED', submittedAt: '', body: '' }]);
    expect(context.reviewComments).toEqual([
      { author: 'unknown', path: '', line: null, side: 'RIGHT', createdAt: '', body: '', inReplyTo: null },
      { author: 'unknown', path: 'src/a.ts', line: null, side: 'RIGHT', createdAt: '2026-09-02T12:00:00Z', body: 'This leaks the token', inReplyTo: null },
    ]);
  });

  it('says nothing was there when the forge answers with nothing of the sort', async () => {
    const { run } = fakeGh(['[]'], 'null');

    const context = await fetchPrContext(snapshot(), run);

    expect([context.comments, context.reviews, context.reviewComments]).toEqual([[], [], []]);
  });

  it('fails when the forge cannot be read, rather than reporting an empty discussion', async () => {
    await expect(fetchPrContext(snapshot(), () => Promise.reject(new Error('gh pr view failed: no access'))))
      .rejects.toThrow('no access');
    await expect(fetchPrContext(snapshot(), () => Promise.resolve('not json'))).rejects.toThrow();
  });
});

describe('parseReviewComments', () => {
  it('takes one page as it comes, and an answer that is not a list as none', () => {
    expect(parseReviewComments(JSON.stringify([inline({ side: 'LEFT' })]))).toEqual([{
      author: 'carol', path: 'src/a.ts', line: 12, side: 'LEFT',
      createdAt: '2026-09-02T12:00:00Z', body: 'This leaks the token', inReplyTo: null,
    }]);
    expect(parseReviewComments('{"message":"Not Found"}')).toEqual([]);
  });
});

describe('cutText', () => {
  it('leaves text that fits alone', () => {
    expect(cutText('short', 10)).toBe('short');
    expect(cutText('exactly-10', 10)).toBe('exactly-10');
  });

  it('marks what it cut', () => {
    expect(cutText('abcdef', 3)).toBe('abc\n… [cut]');
  });
});
