import { describe, it, expect } from 'vitest';
import { matchCreatedComments } from '../src/comment-ids.js';

describe('matchCreatedComments', () => {
  it('pairs a created comment with the finding it came from', () => {
    const pairs = matchCreatedComments(
      [{ threadId: 't1', path: 'src/a.ts', body: 'P2: the finding', endLine: 10 }],
      [{ id: 900, path: 'src/a.ts', body: 'P2: the finding', line: 10 }],
    );

    expect(pairs).toEqual([{ threadId: 't1', githubCommentId: 900 }]);
  });

  it('pairs identical findings in one file in order, not both to the first id', () => {
    const pairs = matchCreatedComments(
      [
        { threadId: 't1', path: 'src/a.ts', body: 'P3: magic number', endLine: 5 },
        { threadId: 't2', path: 'src/a.ts', body: 'P3: magic number', endLine: 5 },
      ],
      [
        { id: 900, path: 'src/a.ts', body: 'P3: magic number', line: 5 },
        { id: 901, path: 'src/a.ts', body: 'P3: magic number', line: 5 },
      ],
    );

    expect(pairs).toEqual([
      { threadId: 't1', githubCommentId: 900 },
      { threadId: 't2', githubCommentId: 901 },
    ]);
  });

  it('pairs identical wording on different lines by the line, whatever order the forge lists them in', () => {
    const pairs = matchCreatedComments(
      [
        { threadId: 't1', path: 'src/a.ts', body: 'P3: magic number', endLine: 5 },
        { threadId: 't2', path: 'src/a.ts', body: 'P3: magic number', endLine: 40 },
      ],
      [
        { id: 901, path: 'src/a.ts', body: 'P3: magic number', line: 40 },
        { id: 900, path: 'src/a.ts', body: 'P3: magic number', line: 5 },
      ],
    );

    expect(pairs).toEqual([
      { threadId: 't1', githubCommentId: 900 },
      { threadId: 't2', githubCommentId: 901 },
    ]);
  });

  it('pairs on path and body alone when the forge reports no line', () => {
    const pairs = matchCreatedComments(
      [{ threadId: 't1', path: 'src/a.ts', body: 'P2: the finding', endLine: 10 }],
      [{ id: 900, path: 'src/a.ts', body: 'P2: the finding', line: null }],
    );

    expect(pairs).toEqual([{ threadId: 't1', githubCommentId: 900 }]);
  });

  it('leaves a finding unpaired when the forge shows nothing matching', () => {
    const pairs = matchCreatedComments(
      [{ threadId: 't1', path: 'src/a.ts', body: 'P2: the finding', endLine: 10 }],
      [{ id: 900, path: 'src/a.ts', body: 'a different wording', line: 10 }],
    );

    expect(pairs).toEqual([]);
  });

  it('skips a sent comment that carries no thread', () => {
    const pairs = matchCreatedComments(
      [{ path: 'src/a.ts', body: 'P2: the finding', endLine: 10 }],
      [{ id: 900, path: 'src/a.ts', body: 'P2: the finding', line: 10 }],
    );

    expect(pairs).toEqual([]);
  });

  it('does not pair across files even with identical wording', () => {
    const pairs = matchCreatedComments(
      [{ threadId: 't1', path: 'src/a.ts', body: 'P2: the finding', endLine: 10 }],
      [{ id: 900, path: 'src/b.ts', body: 'P2: the finding', line: 10 }],
    );

    expect(pairs).toEqual([]);
  });
});
