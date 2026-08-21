import { describe, it, expect } from 'vitest';
import {
  isGeneral,
  isSubmittable,
  summaryFromGeneralThreads,
  threadToPayload,
} from '../src/lib/review-submission';
import { GENERAL_THREAD_FILE_PATH } from '../src/components/comments/types';
import type { CommentThread, ThreadStatus } from '../src/components/comments/types';

function comment(body: string, name = 'You') {
  return { id: body, author: { name, type: 'user' as const }, body, createdAt: '2026-08-21T10:00:00.000Z' };
}

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 't1',
    filePath: 'src/a.ts',
    side: 'new',
    startLine: 10,
    endLine: 10,
    comments: [comment('P1: missing null check')],
    status: 'open' as ThreadStatus,
    ...overrides,
  };
}

describe('threadToPayload', () => {
  it('maps a single-line comment on the new side', () => {
    expect(threadToPayload(thread())).toEqual({
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

  it('folds replies into one body, attributed', () => {
    const payload = threadToPayload(
      thread({
        comments: [comment('P2: name is unclear'), comment('agreed, renaming', 'Agent')],
      }),
    );

    expect(payload.body).toBe('P2: name is unclear\n\n---\n\n**Agent:** agreed, renaming');
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

  it('recognises a general thread', () => {
    expect(isGeneral(thread({ filePath: GENERAL_THREAD_FILE_PATH }))).toBe(true);
    expect(isGeneral(thread())).toBe(false);
  });
});
