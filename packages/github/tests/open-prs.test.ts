import { describe, it, expect } from 'vitest';
import { listOpenPrs, parseOpenPrs, prDiff } from '../src/inbox.js';

/** One pull request as `gh search prs --json …` reports one, the forge's own field names and all. */
function found(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 14587,
    title: 'Add a widget',
    body: '* platform - risk level: high',
    author: { login: 'alice', is_bot: false, type: 'User' },
    updatedAt: '2026-09-02T10:00:00Z',
    url: 'https://github.com/o/r/pull/14587',
    repository: { name: 'r', nameWithOwner: 'o/r' },
    ...over,
  };
}

describe('parseOpenPrs', () => {
  it('takes the coordinates, the description and the author off one search page', () => {
    expect(parseOpenPrs(JSON.stringify([found()]))).toEqual([{
      owner: 'o', repo: 'r', number: 14587, title: 'Add a widget',
      body: '* platform - risk level: high', author: 'alice', isBot: false,
      url: 'https://github.com/o/r/pull/14587', updatedAt: '2026-09-02T10:00:00Z',
    }]);
  });

  it('reads an app\'s pull request as a bot, whichever way the search says so', () => {
    expect(parseOpenPrs(JSON.stringify([
      found({ author: { login: 'dependabot[bot]', is_bot: false, type: 'Bot' } }),
      found({ number: 2, author: { login: 'ncrobot', is_bot: true, type: 'User' } }),
    ])).map(pr => pr.isBot)).toEqual([true, true]);
  });

  it('fills in what the forge left out rather than dropping the pull request', () => {
    expect(parseOpenPrs(JSON.stringify([{ number: 7, repository: { nameWithOwner: 'o/r' } }]))).toEqual([{
      owner: 'o', repo: 'r', number: 7, title: '', body: '', author: '', isBot: false, url: '', updatedAt: '',
    }]);
  });

  it('skips a row that names no repository or no number, and answers nothing for a non-list', () => {
    expect(parseOpenPrs(JSON.stringify([
      found(),
      { number: 8 },
      { repository: { nameWithOwner: 'o/r' } },
      { number: 9, repository: { nameWithOwner: 'justarepo' } },
      null,
    ])).map(pr => pr.number)).toEqual([14587]);
    expect(parseOpenPrs('{}')).toEqual([]);
    expect(parseOpenPrs('null')).toEqual([]);
  });
});

describe('listOpenPrs', () => {
  it('asks for the open, non-draft pull requests of one repository, with their descriptions', async () => {
    const calls: string[][] = [];
    const prs = await listOpenPrs('o/r', args => {
      calls.push(args);
      return Promise.resolve(JSON.stringify([found()]));
    });

    expect(calls).toEqual([[
      'search', 'prs', '--repo', 'o/r', '--state=open', '--draft=false', '--limit', '100',
      '--json', 'number,title,body,author,updatedAt,url,repository',
    ]]);
    expect(prs.map(pr => pr.number)).toEqual([14587]);
  });

  it('lets a forge that cannot be read throw, so the caller decides what to do about it', async () => {
    await expect(listOpenPrs('o/r', () => Promise.reject(new Error('gh search prs failed: no access'))))
      .rejects.toThrow(/no access/);
  });
});

describe('prDiff', () => {
  it('asks the forge for the pull request\'s own diff, uncut', async () => {
    const calls: string[][] = [];
    const diff = await prDiff({ owner: 'o', repo: 'r', number: 14587 }, args => {
      calls.push(args);
      return Promise.resolve('diff --git a/src/a.ts b/src/a.ts');
    });

    expect(calls).toEqual([['pr', 'diff', '14587', '--repo', 'o/r']]);
    expect(diff).toBe('diff --git a/src/a.ts b/src/a.ts');
  });
});
