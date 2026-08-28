import { describe, it, expect } from 'vitest';
import {
  canSubmitReview,
  isGeneral,
  isSubmittable,
  summaryFromGeneralThreads,
  threadToPayload,
} from '../src/lib/review-submission';
import { GENERAL_THREAD_FILE_PATH } from '../src/components/comments/types';
import type { CommentThread } from '../src/components/comments/types';
import { makeComment, makeThread } from './helpers/wire';

function comment(body: string, name = 'You') {
  return makeComment({ id: body, author: { name, type: 'user' }, body, createdAt: '2026-08-21T10:00:00.000Z' });
}

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return makeThread({ comments: [comment('P1: missing null check')], ...overrides });
}

describe('threadToPayload', () => {
  it('maps a single-line comment on the new side', () => {
    expect(threadToPayload(thread())).toEqual({
      threadId: 't1',
      filePath: 'src/a.ts',
      side: 'RIGHT',
      startLine: null,
      endLine: 10,
      body: 'P1: missing null check',
    });
  });

  it('keeps the start line only for a range', () => {
    const payload = threadToPayload(thread({ startLine: 10, endLine: 14 }));

    expect(payload.startLine).toBe(10);
    expect(payload.endLine).toBe(14);
  });

  it('maps the old side to LEFT', () => {
    expect(threadToPayload(thread({ side: 'old' })).side).toBe('LEFT');
  });

  it('sends the finding alone, however much was said after it', () => {
    const payload = threadToPayload(
      thread({
        comments: [comment('P2: name is unclear'), comment('agreed, renaming', 'Agent')],
      }),
    );

    expect(payload.body).toBe('P2: name is unclear');
  });
});

describe('isSubmittable', () => {
  it('takes open line comments', () => {
    expect(isSubmittable(thread())).toBe(true);
  });

  it('leaves out resolved and dismissed threads', () => {
    expect(isSubmittable(thread({ status: 'resolved' }))).toBe(false);
    expect(isSubmittable(thread({ status: 'dismissed' }))).toBe(false);
  });

  it('leaves out general comments, which have no line', () => {
    expect(isSubmittable(thread({ filePath: GENERAL_THREAD_FILE_PATH }))).toBe(false);
  });

  it('takes a thread with replies, which the old per-comment push dropped', () => {
    expect(isSubmittable(thread({ comments: [comment('a'), comment('b')] }))).toBe(true);
  });
});

describe('summaryFromGeneralThreads', () => {
  it('joins open general comments', () => {
    const summary = summaryFromGeneralThreads([
      thread({ id: 'g1', filePath: GENERAL_THREAD_FILE_PATH, comments: [comment('Reading order …')] }),
      thread({ id: 'l1' }),
      thread({ id: 'g2', filePath: GENERAL_THREAD_FILE_PATH, comments: [comment('Overall: solid')] }),
    ]);

    expect(summary).toBe('Reading order …\n\nOverall: solid');
  });

  it('ignores dismissed general comments', () => {
    const summary = summaryFromGeneralThreads([
      thread({ filePath: GENERAL_THREAD_FILE_PATH, status: 'dismissed', comments: [comment('nope')] }),
    ]);

    expect(summary).toBe('');
  });

  it('is empty when there are none', () => {
    expect(summaryFromGeneralThreads([thread()])).toBe('');
  });

  it('leaves the conversation about a summary out of it', () => {
    const summary = summaryFromGeneralThreads([
      thread({
        filePath: GENERAL_THREAD_FILE_PATH,
        comments: [
          { ...comment('Verdict: two findings, both small'), kind: 'review' as const },
          { ...comment('why only two?', 'You'), kind: 'aside' as const },
          { ...comment('because the third turned out to be mine', 'Agent'), kind: 'aside' as const },
          { ...comment('a reply nobody folded in', 'Agent'), kind: 'review' as const },
        ],
      }),
    ]);

    expect(summary).toBe('Verdict: two findings, both small');
  });

  it('contributes nothing from a thread that is only a question', () => {
    const summary = summaryFromGeneralThreads([
      thread({
        filePath: GENERAL_THREAD_FILE_PATH,
        comments: [{ ...comment('what did you not check?', 'You'), kind: 'aside' as const }],
      }),
      thread({ id: 'g2', filePath: GENERAL_THREAD_FILE_PATH, comments: [comment('Verdict: fine')] }),
    ]);

    expect(summary).toBe('Verdict: fine');
  });

  it('recognises a general thread', () => {
    expect(isGeneral(thread({ filePath: GENERAL_THREAD_FILE_PATH }))).toBe(true);
    expect(isGeneral(thread())).toBe(false);
  });
});

describe('canSubmitReview', () => {
  it('needs something to say for a plain comment', () => {
    expect(canSubmitReview({ event: 'COMMENT', comments: 0, summary: '' })).toBe(false);
    expect(canSubmitReview({ event: 'COMMENT', comments: 0, summary: '   ' })).toBe(false);
    expect(canSubmitReview({ event: 'COMMENT', comments: 1, summary: '' })).toBe(true);
    expect(canSubmitReview({ event: 'COMMENT', comments: 0, summary: 'looks fine' })).toBe(true);
  });

  it('lets a verdict stand on its own', () => {
    // An approval with nothing attached is a normal thing to send, and the forge accepts it.
    expect(canSubmitReview({ event: 'APPROVE', comments: 0, summary: '' })).toBe(true);
    expect(canSubmitReview({ event: 'REQUEST_CHANGES', comments: 0, summary: '' })).toBe(true);
  });

  it('refuses anything while a review is still running', () => {
    expect(canSubmitReview({ event: 'APPROVE', comments: 0, summary: '', reviewInProgress: true })).toBe(false);
    expect(canSubmitReview({ event: 'COMMENT', comments: 5, summary: 'x', reviewInProgress: true })).toBe(false);
  });
});

describe('what a thread sends to the forge', () => {
  function withComments(comments: { body: string; kind?: 'review' | 'aside'; name?: string }[]): CommentThread {
    return makeThread({
      createdAt: '2026-08-24T10:00:00.000Z',
      updatedAt: '2026-08-24T10:00:00.000Z',
      comments: comments.map((c, i) => makeComment({
        id: `c${i}`,
        body: c.body,
        kind: c.kind ?? 'review',
        author: { name: c.name ?? 'Agent', type: 'agent' },
        createdAt: '2026-08-24T10:00:00.000Z',
      })),
    });
  }

  it('sends the finding and nothing else', () => {
    const payload = threadToPayload(withComments([
      { body: 'P2: the finding' },
      { body: 'a reply that was never folded into the finding', name: 'You' },
    ]));

    expect(payload.body).toBe('P2: the finding');
  });

  it('sends an amended finding once, not the answer that produced it as well', () => {
    const payload = threadToPayload(withComments([
      { body: 'P2: the finding, amended to carry the answer' },
      { body: 'is our money handling affected?', kind: 'aside', name: 'You' },
      { body: 'No, and I was wrong to point at refunds. I have amended the finding.' },
    ]));

    expect(payload.body).toBe('P2: the finding, amended to carry the answer');
  });

  // An aside is a conversation with the agent about the review. Posting it would put the whole
  // exchange on the pull request, where nobody asked for it.
  it('leaves an aside behind', () => {
    const payload = threadToPayload(withComments([
      { body: 'P2: the finding' },
      { body: 'what do you mean by the marker?', kind: 'aside', name: 'You' },
      { body: 'the submitted_at column', kind: 'aside' },
    ]));

    expect(payload.body).toBe('P2: the finding');
  });

  it('sends nothing but the finding when every reply is an aside', () => {
    const payload = threadToPayload(withComments([
      { body: 'P3: a small thing' },
      { body: 'is this worth doing?', kind: 'aside', name: 'You' },
    ]));

    expect(payload.body).toBe('P3: a small thing');
  });

  it('treats a comment written before kinds existed as a review comment', () => {
    const thread = withComments([{ body: 'P1: old finding' }, { body: 'old reply', name: 'You' }]);
    for (const comment of thread.comments) {
      delete (comment as { kind?: string }).kind;
    }

    // Were the default an aside, there would be no finding here to send.
    expect(threadToPayload(thread).body).toBe('P1: old finding');
  });
});

describe('a thread that is only a conversation', () => {
  function askOnly(): CommentThread {
    return makeThread({
      id: 't2',
      startLine: 4,
      endLine: 4,
      createdAt: '2026-08-24T10:00:00.000Z',
      updatedAt: '2026-08-24T10:00:00.000Z',
      comments: [makeComment({
        id: 'c0',
        body: 'what does this function do?',
        kind: 'aside',
        author: { name: 'You', type: 'user' },
        createdAt: '2026-08-24T10:00:00.000Z',
      })],
    });
  }

  // Asking about a line nobody has commented on starts a thread with no finding in it. Offering
  // that to the forge would post an empty comment, or crash reading a first review comment that
  // is not there.
  it('is not offered to the forge', () => {
    expect(isSubmittable(askOnly())).toBe(false);
  });

  it('is offered once a finding is added to it', () => {
    const thread = askOnly();
    thread.comments.push(makeComment({
      id: 'c1',
      body: 'P2: and here is the finding',
      author: { name: 'Agent', type: 'agent' },
      createdAt: '2026-08-24T10:00:02.000Z',
    }));

    expect(isSubmittable(thread)).toBe(true);
  });
});
