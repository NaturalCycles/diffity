import { describe, it, expect } from 'vitest';
import { newAnswers, previewOf, dropSeenAlerts, PREVIEW_LINES } from '../src/lib/answer-alerts';
import type { CommentThread } from '../src/components/comments/types';

function thread(id: string, comments: { id: string; type: 'user' | 'agent'; kind?: 'review' | 'aside'; body?: string }[]): CommentThread {
  return {
    id,
    filePath: `src/${id}.ts`,
    side: 'new',
    startLine: 10,
    endLine: 10,
    status: 'open',
    comments: comments.map(c => ({
      id: c.id,
      body: c.body ?? 'a reply',
      kind: c.kind ?? 'aside',
      author: { name: c.type === 'agent' ? 'Agent' : 'You', type: c.type },
      createdAt: '2026-08-24T10:00:00.000Z',
    })),
  } as unknown as CommentThread;
}

describe('spotting an answer that just arrived', () => {
  it('finds an agent reply that was not there before', () => {
    const before = [thread('a', [{ id: 'c1', type: 'user' }])];
    const after = [thread('a', [{ id: 'c1', type: 'user' }, { id: 'c2', type: 'agent', body: 'here you go' }])];

    const alerts = newAnswers(before, after);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].threadId).toBe('a');
    expect(alerts[0].preview).toContain('here you go');
  });

  it('says nothing when nothing arrived', () => {
    const same = [thread('a', [{ id: 'c1', type: 'user' }, { id: 'c2', type: 'agent' }])];

    expect(newAnswers(same, [...same])).toEqual([]);
  });

  // Your own comment appearing is not news to you.
  it('ignores your own comments', () => {
    const before = [thread('a', [{ id: 'c1', type: 'user' }])];
    const after = [thread('a', [{ id: 'c1', type: 'user' }, { id: 'c2', type: 'user' }])];

    expect(newAnswers(before, after)).toEqual([]);
  });

  // A finding is not an answer to anything — it belongs in the diff, not in a bubble.
  it('ignores an agent review comment', () => {
    const before = [thread('a', [{ id: 'c1', type: 'user' }])];
    const after = [thread('a', [{ id: 'c1', type: 'user' }, { id: 'c2', type: 'agent', kind: 'review' }])];

    expect(newAnswers(before, after)).toEqual([]);
  });

  it('says nothing on the first look, when everything is new', () => {
    const after = [thread('a', [{ id: 'c1', type: 'agent' }])];

    expect(newAnswers(null, after)).toEqual([]);
  });

  it('finds answers on several threads at once', () => {
    const before = [thread('a', [{ id: 'a1', type: 'user' }]), thread('b', [{ id: 'b1', type: 'user' }])];
    const after = [
      thread('a', [{ id: 'a1', type: 'user' }, { id: 'a2', type: 'agent' }]),
      thread('b', [{ id: 'b1', type: 'user' }, { id: 'b2', type: 'agent' }]),
    ];

    expect(newAnswers(before, after).map(a => a.threadId)).toEqual(['a', 'b']);
  });

  it('finds one on a thread that did not exist before', () => {
    const before = [thread('a', [{ id: 'a1', type: 'user' }])];
    const after = [...before, thread('b', [{ id: 'b1', type: 'agent' }])];

    expect(newAnswers(before, after).map(a => a.threadId)).toEqual(['b']);
  });
});

describe('how much of the answer is shown', () => {
  it('keeps a short answer whole', () => {
    expect(previewOf('two words')).toBe('two words');
  });

  it('stops after a few lines', () => {
    const many = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');

    expect(previewOf(many).split('\n')).toHaveLength(PREVIEW_LINES);
  });

  it('says it was cut rather than trailing off', () => {
    const many = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');

    expect(previewOf(many).endsWith('…')).toBe(true);
  });

  it('trims a single very long line too', () => {
    const preview = previewOf('x'.repeat(500));

    expect(preview.length).toBeLessThan(500);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('dropping notes the reader has caught up with', () => {
  const alerts = [
    { threadId: 'a', filePath: 'a.ts', authorName: 'Agent', preview: 'one' },
    { threadId: 'b', filePath: 'b.ts', authorName: 'Agent', preview: 'two' },
  ];

  it('drops the one now on screen and keeps the other', () => {
    expect(dropSeenAlerts(alerts, id => id === 'a').map(a => a.threadId)).toEqual(['b']);
  });

  it('keeps everything while nothing is on screen', () => {
    expect(dropSeenAlerts(alerts, () => false)).toBe(alerts);
  });

  it('empties out when the reader has caught up with all of them', () => {
    expect(dropSeenAlerts(alerts, () => true)).toEqual([]);
  });
});

describe('a page that has just been rebuilt', () => {
  // Threads are an empty array while the query loads. Recording that as "what I have seen" makes
  // every existing answer look new on the next poll — which is a page reload announcing the whole
  // conversation back at you.
  it('announces nothing when the first look was an empty load', () => {
    const loaded = [thread('a', [{ id: 'c1', type: 'user' }, { id: 'c2', type: 'agent' }])];

    expect(newAnswers([], loaded)).toEqual([]);
  });

  it('still announces an answer that arrives after a real look', () => {
    const before = [thread('a', [{ id: 'c1', type: 'user' }])];
    const after = [thread('a', [{ id: 'c1', type: 'user' }, { id: 'c2', type: 'agent' }])];

    expect(newAnswers(before, after)).toHaveLength(1);
  });
});
