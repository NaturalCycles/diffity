import type { NextFunction, Request, Response } from 'express';

export const SESSION_COOKIE = 'diffity_session';

/**
 * Repository content is rendered in the review UI, so nothing it contains may reach the network.
 * The same policy the CLI serves its UI under.
 */
export const UI_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "connect-src 'self'",
].join('; ');

/** The server's own pages: no script at all, forms only to this origin unless widened for one. */
export function pageContentSecurityPolicy(extraFormTargets: string[] = []): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    `form-action 'self'${extraFormTargets.map(target => ` ${target}`).join('')}`,
    "img-src 'self'",
    "style-src 'unsafe-inline'",
  ].join('; ');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) {
      continue;
    }
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function sessionCookie(value: string, options: { secure: boolean; maxAgeSeconds: number }): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAgeSeconds}`,
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');
}

/**
 * A cross-site page cannot forge these, and the UI's own fetches and forms always satisfy them.
 * The host comparison covers reaching a localhost server through another loopback name.
 */
export function isSameOriginRequest(req: Request, publicUrl: URL): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin') {
    return false;
  }
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  if (origin === publicUrl.origin) {
    return true;
  }
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function requireSameOrigin(publicUrl: URL) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isSameOriginRequest(req, publicUrl)) {
      res.status(403).json({ error: 'Cross-origin request rejected' });
      return;
    }
    next();
  };
}

/** Only a path on this server: an absolute or protocol-relative URL would be an open redirect. */
export function safeNext(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return '/';
  }
  return value;
}
