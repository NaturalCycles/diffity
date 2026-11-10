import { markSignedOut } from './sign-in';

/**
 * The server never redirects these requests; a redirect is IAP sending an expired sign-in to Google, which
 * a fetch cannot follow.
 */
export async function apiRequest(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, redirect: 'manual' });
  if (res.type === 'opaqueredirect') {
    markSignedOut();
    throw new Error('Signed out');
  }
  return res;
}
