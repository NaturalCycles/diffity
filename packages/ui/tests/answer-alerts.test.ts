import { describe, it, expect } from 'vitest';
import {
  addAlerts,
  alertLabel,
  answeredThreads,
  dropSeenAlerts,
  overlaps,
  type AnswerAlert,
} from '../src/lib/answer-alerts';
import { addBadge, titleWithCount, toHref } from '../src/lib/favicon-badge';
import type { Comment } from '../src/components/comments/types';
import { makeComment, makeThread } from './helpers/wire';

const question = (ask: Comment['ask']) =>
  makeComment({ id: 'q', author: { name: 'You', type: 'user' }, kind: 'aside', body: 'why?', ask });
const reply = (id = 'r', type: 'agent' | 'user' = 'agent') =>
  makeComment({ id, author: { name: type === 'agent' ? 'Agent' : 'You', type }, kind: 'aside', body: 'because' });

const ids = (threads: { id: string }[]) => threads.map(thread => thread.id);

describe('answeredThreads', () => {
  it('finds a pending question that turned answered', () => {
    const before = [makeThread({ comments: [question('pending')] })];
    const after = [makeThread({ comments: [question('answered'), reply()] })];

    expect(ids(answeredThreads(before, after))).toEqual(['t1']);
  });

  it('finds one an agent was working on', () => {
    const before = [makeThread({ comments: [question('working')] })];
    const after = [makeThread({ comments: [question('answered')] })];

    expect(ids(answeredThreads(before, after))).toEqual(['t1']);
  });

  it('counts an agent reply under an open question even before the ask settles', () => {
    const before = [makeThread({ comments: [question('working')] })];
    const after = [makeThread({ comments: [question('working'), reply()] })];

    expect(ids(answeredThreads(before, after))).toEqual(['t1']);
  });

  it('ignores the reader replying to their own question', () => {
    const before = [makeThread({ comments: [question('pending')] })];
    const after = [makeThread({ comments: [question('pending'), reply('r', 'user')] })];

    expect(answeredThreads(before, after)).toEqual([]);
  });

  it('says nothing on the first look', () => {
    expect(answeredThreads(null, [makeThread({ comments: [question('answered'), reply()] })])).toEqual([]);
  });

  it('says nothing for a question that was already answered', () => {
    const same = [makeThread({ comments: [question('answered'), reply()] })];

    expect(answeredThreads(same, [...same])).toEqual([]);
  });

  it('says nothing about an agent reply on a thread with no question', () => {
    const before = [makeThread({ comments: [makeComment({ id: 'f' })] })];
    const after = [makeThread({ comments: [makeComment({ id: 'f' }), reply()] })];

    expect(answeredThreads(before, after)).toEqual([]);
  });

  it('ignores a thread that was not there before', () => {
    const after = [makeThread({ id: 'new', comments: [question('answered'), reply()] })];

    expect(answeredThreads([makeThread()], after)).toEqual([]);
  });

  it('finds several at once', () => {
    const before = [
      makeThread({ id: 'a', comments: [question('pending')] }),
      makeThread({ id: 'b', comments: [question('working')] }),
      makeThread({ id: 'c', comments: [question('pending')] }),
    ];
    const after = [
      makeThread({ id: 'a', comments: [question('answered')] }),
      makeThread({ id: 'b', comments: [question('answered')] }),
      makeThread({ id: 'c', comments: [question('pending')] }),
    ];

    expect(ids(answeredThreads(before, after))).toEqual(['a', 'b']);
  });
});

const alert = (threadId: string, whileHidden = false): AnswerAlert =>
  ({ threadId, filePath: 'src/a.ts', startLine: 3, whileHidden });

describe('addAlerts', () => {
  it('keeps one entry per thread', () => {
    expect(addAlerts([alert('a')], [alert('a'), alert('b')]).map(a => a.threadId)).toEqual(['a', 'b']);
  });

  it('remembers that a thread got an answer while the tab was hidden', () => {
    expect(addAlerts([alert('a', true)], [alert('a', false)])[0].whileHidden).toBe(true);
    expect(addAlerts([alert('a', false)], [alert('a', true)])[0].whileHidden).toBe(true);
  });
});

describe('dropSeenAlerts', () => {
  const alerts = [alert('a'), alert('b')];

  it('drops the thread now on screen', () => {
    expect(dropSeenAlerts(alerts, id => id === 'a').map(a => a.threadId)).toEqual(['b']);
  });

  it('returns the same array when nothing is on screen', () => {
    expect(dropSeenAlerts(alerts, () => false)).toBe(alerts);
  });
});

describe('alertLabel', () => {
  it('names the file and line', () => {
    expect(alertLabel({ ...alert('a'), filePath: 'src/deep/path/file.ts', startLine: 42 })).toBe('file.ts:42');
  });

  it('calls a general thread General', () => {
    expect(alertLabel({ ...alert('a'), filePath: '__general__' })).toBe('General');
  });
});

describe('overlaps', () => {
  const viewport = { top: 50, bottom: 650 };

  it('is on screen when any of it is inside the viewport', () => {
    expect(overlaps({ top: 100, bottom: 200 }, viewport)).toBe(true);
    expect(overlaps({ top: 0, bottom: 60 }, viewport)).toBe(true);
    expect(overlaps({ top: 640, bottom: 900 }, viewport)).toBe(true);
  });

  it('is off screen above or below', () => {
    expect(overlaps({ top: -300, bottom: 50 }, viewport)).toBe(false);
    expect(overlaps({ top: 650, bottom: 800 }, viewport)).toBe(false);
  });
});

describe('tab badge text', () => {
  it('prefixes the title with the count', () => {
    expect(titleWithCount('diffity', 1)).toBe('(1) diffity');
  });

  it('replaces rather than stacks an existing count', () => {
    expect(titleWithCount('(1) diffity', 2)).toBe('(2) diffity');
  });

  it('takes the count off at zero', () => {
    expect(titleWithCount('(3) diffity', 0)).toBe('diffity');
  });

  it('puts the mark inside the icon', () => {
    const badged = addBadge('<svg><path d="M0 0"/></svg>');

    expect(badged).toContain('<path d="M0 0"/>');
    expect(badged.indexOf('<circle')).toBeLessThan(badged.indexOf('</svg>'));
  });

  it('leaves something that is not an icon alone', () => {
    expect(addBadge('not an svg')).toBe('not an svg');
  });

  it('makes a data href without raw quotes', () => {
    expect(toHref('<svg a="b"/>')).toMatch(/^data:image\/svg\+xml,[^"]+$/);
  });
});
