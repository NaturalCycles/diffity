import { markSignedOut } from './sign-in';

/**
 * The server never redirects these requests; a redirect is IAP sending an expired sign-in to Google, which
 * a fetch cannot follow. A 401 is diffity's own sign-in gone. A write that fails this way may have taken the
 * reader's text with it, so the page must not reload on its own.
 */
export async function apiRequest(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, redirect: 'manual' });
  if (res.type === 'opaqueredirect' || res.status === 401) {
    markSignedOut({ lostWrite: (init?.method ?? 'GET').toUpperCase() !== 'GET' });
    throw new Error('Signed out');
  }
  return res;
}
