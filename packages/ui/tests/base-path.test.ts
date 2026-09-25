import { afterEach, describe, expect, it, vi } from 'vitest';
import { normaliseBase, prefixApiPath } from '../src/lib/base';

describe('normaliseBase', () => {
  it('keeps an absolute path without its trailing slash', () => {
    expect(normaliseBase('/s/abc')).toBe('/s/abc');
    expect(normaliseBase('/s/abc/')).toBe('/s/abc');
  });

  it('treats anything else as no base', () => {
    expect(normaliseBase(undefined)).toBe('');
    expect(normaliseBase('')).toBe('');
    expect(normaliseBase('/')).toBe('');
    expect(normaliseBase('https://evil.example')).toBe('');
    expect(normaliseBase(42)).toBe('');
  });
});

describe('prefixApiPath', () => {
  it('prefixes API paths only, and nothing without a base', () => {
    expect(prefixApiPath('/s/abc', '/api/diff?ref=work')).toBe('/s/abc/api/diff?ref=work');
    expect(prefixApiPath('/s/abc', '/favicon.svg')).toBe('/favicon.svg');
    expect(prefixApiPath('', '/api/diff')).toBe('/api/diff');
  });
});

describe('the API client', () => {
  afterEach(() => {
    delete window.__DIFFITY_BASE__;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function requestedUrls(base: string | undefined): Promise<string[]> {
    if (base !== undefined) {
      window.__DIFFITY_BASE__ = base;
    }
    vi.resetModules();
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('../src/lib/api');
    await api.fetchRepoInfo('work');
    await api.fetchThreads('sid');
    await api.fetchGitHubDetails();
    await api.updateThreadStatus('t1', 'resolved');
    return fetchMock.mock.calls.map(call => String((call as unknown[])[0]));
  }

  it('asks the server at the root when the page has no base, as the CLI serves it', async () => {
    expect(await requestedUrls(undefined)).toEqual([
      '/api/info?ref=work',
      '/api/threads?session=sid',
      '/api/github/details',
      '/api/threads/t1/status',
    ]);
  });

  it('asks under the base the hosted server injected', async () => {
    expect(await requestedUrls('/s/abc')).toEqual([
      '/s/abc/api/info?ref=work',
      '/s/abc/api/threads?session=sid',
      '/s/abc/api/github/details',
      '/s/abc/api/threads/t1/status',
    ]);
  });
});
