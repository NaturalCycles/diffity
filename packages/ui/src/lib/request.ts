import { markSignedOut, writeSettled, writeStarted } from './sign-in';

/**
 * The server never redirects these requests; a redirect is IAP sending an expired sign-in to Google, which
 * a fetch cannot follow. A 401 is diffity's own sign-in gone. A write may hold the reader's only copy of their
 * text, so while one is under way, or after one failed this way, the page must not reload on its own.
 */
export async function apiRequest(url: string, init?: RequestInit): Promise<Response> {
  const write = (init?.method ?? 'GET').toUpperCase() !== 'GET';
  if (write) {
    writeStarted();
  }
  try {
    const res = await fetch(url, { ...init, redirect: 'manual' });
    if (res.type === 'opaqueredirect' || res.status === 401) {
      markSignedOut({ lostWrite: write });
      throw new Error('Signed out');
    }
    return res;
  } finally {
    if (write) {
      writeSettled();
    }
  }
}
