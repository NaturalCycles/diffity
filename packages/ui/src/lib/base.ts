declare global {
  interface Window {
    /** Set by the hosted server, which serves each review under its own path. */
    __DIFFITY_BASE__?: string;
  }
}

/** A path prefix with no trailing slash; empty when the page is served at the root. */
export function normaliseBase(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    return '';
  }
  return value.replace(/\/+$/, '');
}

export function prefixApiPath(base: string, url: string): string {
  return base && url.startsWith('/api/') ? `${base}${url}` : url;
}

const BASE = normaliseBase(typeof window === 'undefined' ? undefined : window.__DIFFITY_BASE__);

/** Where the page's routes and API live. Read once: the server writes it before any script runs. */
export function appBase(): string {
  return BASE;
}

export function apiPath(url: string): string {
  return prefixApiPath(BASE, url);
}

/** For the few places that navigate with the browser rather than the router. */
export function pagePath(path: string): string {
  return `${BASE}${path}`;
}
