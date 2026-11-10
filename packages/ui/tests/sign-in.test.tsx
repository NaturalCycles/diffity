import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { apiRequest } from '../src/lib/request';
import { isSignedOut, markSignedOut, readPageState, reloadIfSafe, resetSignInForTests, shouldAutoReload } from '../src/lib/sign-in';
import { SignedOutBanner } from '../src/components/layout/signed-out-banner';

beforeEach(() => {
  resetSignInForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const CLEAN = { visible: true, hasDraft: false, editing: false, lostWrite: false };

describe('the request helper', () => {
  it('asks not to follow redirects and passes a normal response through', async () => {
    const response = new Response('{}', { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);

    expect(await apiRequest('/api/info', { method: 'POST' })).toBe(response);
    expect(fetchMock).toHaveBeenCalledWith('/api/info', { method: 'POST', redirect: 'manual' });
    expect(isSignedOut()).toBe(false);
  });

  it('passes an error response through for the caller to handle', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));

    expect((await apiRequest('/api/info')).status).toBe(500);
    expect(isSignedOut()).toBe(false);
  });

  it('marks the page signed out and rejects on a redirect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ type: 'opaqueredirect', status: 0, ok: false } as Response));

    await expect(apiRequest('/api/info')).rejects.toThrow('Signed out');
    expect(isSignedOut()).toBe(true);
    expect(readPageState().lostWrite).toBe(false);
  });

  it('marks the page signed out on a 401, and never reloads it on its own after a failed write', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));

    await expect(apiRequest('/api/threads/1', { method: 'PATCH' })).rejects.toThrow('Signed out');
    expect(isSignedOut()).toBe(true);
    expect(readPageState().lostWrite).toBe(true);
    expect(reloadIfSafe(vi.fn())).toBe(false);
  });
});

describe('reloading after the sign-in expired', () => {
  it('reloads a visible page with nothing typed', () => {
    expect(shouldAutoReload(CLEAN, false)).toBe(true);
  });

  it('leaves a page with a draft, a focused field or a hidden tab alone', () => {
    expect(shouldAutoReload({ ...CLEAN, hasDraft: true }, false)).toBe(false);
    expect(shouldAutoReload({ ...CLEAN, editing: true }, false)).toBe(false);
    expect(shouldAutoReload({ ...CLEAN, visible: false }, false)).toBe(false);
    expect(shouldAutoReload({ ...CLEAN, lostWrite: true }, false)).toBe(false);
  });

  it('reloads only once', () => {
    const reload = vi.fn();
    expect(reloadIfSafe(reload, CLEAN)).toBe(true);
    expect(reloadIfSafe(reload, CLEAN)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('counts typed text as a draft, and a focused field as editing', () => {
    const textarea = document.createElement('textarea');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    document.body.append(textarea, checkbox);
    expect(readPageState()).toMatchObject({ hasDraft: false, editing: false });

    textarea.value = 'half a comment';
    expect(readPageState().hasDraft).toBe(true);

    textarea.value = '';
    textarea.focus();
    expect(readPageState().editing).toBe(true);
  });
});

describe('the signed-out banner', () => {
  it('shows nothing while signed in', () => {
    render(<SignedOutBanner />);
    expect(screen.queryByTestId('signed-out-banner')).toBeNull();
  });

  it('offers a reload instead of reloading over a draft', () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'unsent';
    document.body.append(textarea);
    render(<SignedOutBanner />);

    act(() => markSignedOut());

    expect(screen.getByTestId('signed-out-banner').textContent).toContain('Your sign-in expired. Reload to sign in again.');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });
});
