import { describe, it, expect } from 'vitest';
import {
  parseCreateThreadRequest,
  parseReplyRequest,
  parseUpdateThreadStatusRequest,
  parseDeleteThreadsRequest,
  parseEditCommentRequest,
  parseCreateTourRequest,
  parseAddTourStepRequest,
  parseUpdateTourStatusRequest,
  parseRevertFileRequest,
  parseRevertHunkRequest,
  parseOpenInEditorRequest,
  parsePullCommentsRequest,
  parseReviewSubmission,
} from '../src/index.js';

const goodThread = {
  sessionId: 's1',
  filePath: 'src/a.ts',
  side: 'new',
  startLine: 3,
  endLine: 5,
  body: 'looks wrong',
  author: { name: 'You', type: 'user' },
};

function errorOf(result: { ok: boolean; error?: string }): string {
  expect(result.ok).toBe(false);
  return (result as { ok: false; error: string }).error;
}

describe('a thread request', () => {
  it('passes with exactly the fields it sent', () => {
    const result = parseCreateThreadRequest({ ...goodThread, kind: 'aside', live: true, intent: 'act' });

    expect(result).toEqual({
      ok: true,
      value: { ...goodThread, anchorContent: undefined, kind: 'aside', live: true, intent: 'act',
        author: { name: 'You', type: 'user', avatarUrl: undefined } },
    });
  });

  it('is built from the fields it names, so extras never reach storage', () => {
    const result = parseCreateThreadRequest({
      ...goodThread,
      author: { name: 'You', type: 'user', role: 'admin' },
      extra: 'field',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toHaveProperty('extra');
      expect(result.value.author).not.toHaveProperty('role');
    }
  });

  it.each([
    [{ ...goodThread, author: { name: 1, type: 'user' } }, 'author.name'],
    [{ ...goodThread, author: { name: 'You', type: 'robot' } }, 'author.type must be one of: user, agent'],
    [{ ...goodThread, author: 'You' }, 'author must be an object'],
    [{ ...goodThread, side: 'sideways' }, 'side must be one of: old, new'],
    [{ ...goodThread, startLine: 1.5 }, 'startLine must be an integer >= 0'],
    [{ ...goodThread, startLine: -1 }, 'startLine'],
    [{ ...goodThread, endLine: '5' }, 'endLine'],
    [{ ...goodThread, body: '' }, 'body must be a non-empty string'],
    [{ ...goodThread, kind: 'weird' }, 'kind must be one of: review, aside'],
    [{ ...goodThread, live: 'yes' }, 'live must be a boolean'],
    [{ ...goodThread, intent: 'do-it' }, 'intent must be one of: ask, act'],
    [{ ...goodThread, sessionId: undefined }, 'sessionId'],
  ])('rejects %j naming the field', (body, expected) => {
    expect(errorOf(parseCreateThreadRequest(body))).toContain(expected);
  });

  it('rejects a body that is not an object', () => {
    expect(errorOf(parseCreateThreadRequest(null))).toContain('request body must be an object');
    expect(errorOf(parseCreateThreadRequest([goodThread]))).toContain('request body');
    expect(errorOf(parseCreateThreadRequest('{}'))).toContain('request body');
  });

  it('allows line 0, where general comments live', () => {
    expect(parseCreateThreadRequest({ ...goodThread, startLine: 0, endLine: 0 }).ok).toBe(true);
  });
});

describe('the smaller bodies', () => {
  it('replies need body and author', () => {
    expect(parseReplyRequest({ body: 'hi', author: { name: 'A', type: 'agent' } }).ok).toBe(true);
    expect(errorOf(parseReplyRequest({ body: 'hi' }))).toContain('author');
    expect(errorOf(parseReplyRequest({ body: 'hi', author: { name: 'A', type: 'agent' }, intent: 'maybe' }))).toContain('intent');
  });

  it('status must be a real status', () => {
    expect(parseUpdateThreadStatusRequest({ status: 'resolved', summary: 'done' }).ok).toBe(true);
    expect(errorOf(parseUpdateThreadStatusRequest({ status: 'zapped' })))
      .toBe('status must be one of: open, resolved, dismissed');
  });

  it('deleting all threads names the session', () => {
    expect(parseDeleteThreadsRequest({ sessionId: 's1' }).ok).toBe(true);
    expect(errorOf(parseDeleteThreadsRequest({}))).toContain('sessionId');
  });

  it('an edit needs its new body', () => {
    expect(parseEditCommentRequest({ body: 'new text' }).ok).toBe(true);
    expect(errorOf(parseEditCommentRequest({ body: 2 }))).toContain('body');
  });

  it('tours need a session and a topic; steps need a place', () => {
    expect(parseCreateTourRequest({ sessionId: 's1', topic: 'Reading order' }).ok).toBe(true);
    expect(errorOf(parseCreateTourRequest({ sessionId: 's1' }))).toContain('topic');
    expect(parseAddTourStepRequest({ filePath: 'a.ts', startLine: 1, endLine: 2 }).ok).toBe(true);
    expect(errorOf(parseAddTourStepRequest({ filePath: 'a.ts', startLine: 1, endLine: 2.5 }))).toContain('endLine');
    expect(parseUpdateTourStatusRequest({ status: 'ready' }).ok).toBe(true);
    expect(errorOf(parseUpdateTourStatusRequest({ status: 'done' }))).toBe('status must be one of: building, ready');
  });

  it('reverts name what they revert', () => {
    expect(parseRevertFileRequest({ filePath: 'a.ts', isUntracked: false }).ok).toBe(true);
    expect(errorOf(parseRevertFileRequest({ filePath: 42 }))).toContain('filePath');
    expect(errorOf(parseRevertFileRequest({ filePath: 'a.ts', isUntracked: 'yes' }))).toContain('isUntracked');
    expect(parseRevertHunkRequest({ patch: 'diff --git ...' }).ok).toBe(true);
    expect(errorOf(parseRevertHunkRequest({ patch: '' }))).toContain('patch');
  });

  it('the editor path may be empty, which means the repository root', () => {
    expect(parseOpenInEditorRequest({ filePath: '' }).ok).toBe(true);
    expect(parseOpenInEditorRequest({ filePath: 'a.ts', line: 3 }).ok).toBe(true);
    expect(errorOf(parseOpenInEditorRequest({ filePath: 'a.ts', line: 0 }))).toContain('line');
  });

  it('pulling comments names the session', () => {
    expect(parsePullCommentsRequest({ sessionId: 's1' }).ok).toBe(true);
    expect(errorOf(parsePullCommentsRequest({ sessionId: '' }))).toContain('sessionId');
  });
});

describe('a review submission', () => {
  const comment = {
    threadId: 't1',
    filePath: 'src/a.ts',
    side: 'RIGHT',
    startLine: null,
    endLine: 5,
    body: 'P2: rename this',
  };

  it('passes whole and defaults what may be absent', () => {
    const result = parseReviewSubmission({ event: 'COMMENT', comments: [comment] });

    expect(result).toEqual({
      ok: true,
      value: { event: 'COMMENT', body: '', comments: [{ ...comment }] },
    });
  });

  it('rejects an unknown verdict instead of coercing it', () => {
    expect(errorOf(parseReviewSubmission({ event: 'SHIP_IT' })))
      .toBe('event must be one of: COMMENT, APPROVE, REQUEST_CHANGES');
  });

  it('names the comment that is wrong', () => {
    expect(errorOf(parseReviewSubmission({ event: 'COMMENT', comments: [comment, { ...comment, side: 'left' }] })))
      .toBe('comments[1].side must be one of: LEFT, RIGHT');
    expect(errorOf(parseReviewSubmission({ event: 'COMMENT', comments: [{ ...comment, endLine: 0 }] })))
      .toContain('comments[0].endLine');
    expect(errorOf(parseReviewSubmission({ event: 'COMMENT', comments: 'none' })))
      .toBe('comments must be an array');
  });
});
