import { describe, it, expect } from 'vitest';
import { BUNDLE_FORMAT_VERSION, parseReviewBundle } from '../src/bundle.js';

function validBundle(): Record<string, unknown> {
  return {
    formatVersion: BUNDLE_FORMAT_VERSION,
    headSha: 'a'.repeat(40),
    ref: 'main',
    baseSha: 'b'.repeat(40),
    repo: { owner: 'o', repo: 'r' },
    prNumber: 12,
    createdAt: '2026-09-02T10:00:00.000Z',
    generator: 'diffity 0.10.7',
    threads: [
      {
        filePath: 'src/a.ts',
        side: 'new',
        startLine: 4,
        endLine: 6,
        status: 'open',
        anchorContent: 'const a = 1;',
        comments: [
          { author: { name: 'Agent', type: 'agent' }, body: 'P2: name this', kind: 'review', createdAt: '2026-09-02T10:00:00.000Z' },
          { author: { name: 'You', type: 'user' }, body: 'agreed', kind: 'aside', createdAt: '2026-09-02T10:01:00.000Z' },
        ],
      },
      {
        filePath: '__general__',
        side: 'new',
        startLine: 0,
        endLine: 0,
        status: 'resolved',
        anchorContent: null,
        comments: [
          { author: { name: 'Agent', type: 'agent' }, body: 'Looks fine overall', kind: 'review', createdAt: '2026-09-02T10:00:00.000Z' },
        ],
      },
    ],
    tours: [
      {
        topic: 'Reading order',
        body: 'Start where the data enters',
        status: 'ready',
        steps: [
          { filePath: 'src/a.ts', startLine: 1, endLine: 3, body: 'The entry point', annotation: 'read first' },
        ],
      },
    ],
  };
}

function errorOf(input: unknown): string {
  const result = parseReviewBundle(input);
  if (result.ok) {
    throw new Error('expected the bundle to be rejected');
  }
  return result.error;
}

describe('parseReviewBundle', () => {
  it('accepts a complete bundle and keeps every field', () => {
    const input = validBundle();
    const result = parseReviewBundle(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(input);
  });

  it('fills in the optional context fields as null and empty text', () => {
    const input = validBundle();
    delete input.baseSha;
    delete input.repo;
    delete input.prNumber;
    (input.tours as Record<string, unknown>[])[0].body = undefined;
    ((input.tours as Record<string, unknown>[])[0].steps as Record<string, unknown>[])[0].annotation = undefined;

    const result = parseReviewBundle(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseSha).toBeNull();
    expect(result.value.repo).toBeNull();
    expect(result.value.prNumber).toBeNull();
    expect(result.value.tours[0].body).toBe('');
    expect(result.value.tours[0].steps[0].annotation).toBe('');
  });

  it('rejects a bundle from a newer format', () => {
    expect(errorOf({ ...validBundle(), formatVersion: BUNDLE_FORMAT_VERSION + 1 }))
      .toContain('newer than this diffity understands');
  });

  it('rejects anything that is not an object, in words about a bundle', () => {
    expect(errorOf('a string')).toBe('The bundle must be an object');
    expect(errorOf(null)).toBe('The bundle must be an object');
    expect(errorOf([])).toBe('The bundle must be an object');
  });

  it('names the missing head', () => {
    const input = validBundle();
    delete input.headSha;
    expect(errorOf(input)).toBe('headSha must be a non-empty string');
  });

  it('refuses a thread without an opening comment', () => {
    const input = validBundle();
    (input.threads as Record<string, unknown>[])[0].comments = [];
    expect(errorOf(input)).toBe('threads[0].comments must not be empty');
  });

  it('holds every enum to its members, naming the field', () => {
    const sideways = validBundle();
    (sideways.threads as Record<string, unknown>[])[1].side = 'sideways';
    expect(errorOf(sideways)).toBe('threads[1].side must be one of: old, new');

    const zapped = validBundle();
    (zapped.threads as Record<string, unknown>[])[0].status = 'zapped';
    expect(errorOf(zapped)).toBe('threads[0].status must be one of: open, resolved, dismissed');

    const robot = validBundle();
    ((robot.threads as Record<string, unknown>[])[0].comments as Record<string, unknown>[])[0].author = { name: 'X', type: 'robot' };
    expect(errorOf(robot)).toBe('threads[0].comments[0].author.type must be one of: user, agent');

    const halfBuilt = validBundle();
    (halfBuilt.tours as Record<string, unknown>[])[0].status = 'half';
    expect(errorOf(halfBuilt)).toBe('tours[0].status must be one of: building, ready');
  });

  it('names where a reversed line range sits', () => {
    const input = validBundle();
    const step = ((input.tours as Record<string, unknown>[])[0].steps as Record<string, unknown>[])[0];
    step.startLine = 5;
    step.endLine = 2;
    expect(errorOf(input)).toBe('tours[0].steps[0].endLine must not be before tours[0].steps[0].startLine');

    const thread = validBundle();
    (thread.threads as Record<string, unknown>[])[1].endLine = 'nine';
    expect(errorOf(thread)).toBe('threads[1].endLine must be an integer >= 0');
  });

  it('normalises timestamps to one form and refuses what is not a time', () => {
    const spaced = validBundle();
    ((spaced.threads as Record<string, unknown>[])[0].comments as Record<string, unknown>[])[0].createdAt = '2026-09-02 12:00:00Z';
    const result = parseReviewBundle(spaced);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.threads[0].comments[0].createdAt).toBe('2026-09-02T12:00:00.000Z');

    const vague = validBundle();
    ((vague.threads as Record<string, unknown>[])[0].comments as Record<string, unknown>[])[0].createdAt = 'yesterday';
    expect(errorOf(vague)).toBe('threads[0].comments[0].createdAt must be an ISO 8601 timestamp with a time zone');

    // Valid ISO 8601, but it would mean a different instant on every machine that reads it.
    const zoneless = validBundle();
    ((zoneless.threads as Record<string, unknown>[])[0].comments as Record<string, unknown>[])[0].createdAt = '2026-09-02T12:00:00';
    expect(errorOf(zoneless)).toBe('threads[0].comments[0].createdAt must be an ISO 8601 timestamp with a time zone');

    expect(errorOf({ ...validBundle(), createdAt: 'soon' })).toBe('createdAt must be an ISO 8601 timestamp with a time zone');
  });

  it('takes an absent base as unknown, but not an empty one', () => {
    expect(errorOf({ ...validBundle(), baseSha: '' })).toBe('baseSha must be a non-empty string');
  });

  it('requires the collections to be arrays', () => {
    expect(errorOf({ ...validBundle(), threads: 'none' })).toBe('threads must be an array');
    expect(errorOf({ ...validBundle(), tours: {} })).toBe('tours must be an array');
  });
});
