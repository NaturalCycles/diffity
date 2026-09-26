import type { Request } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { isAllowedEmail, type Config } from './config.js';
import { escapeHtml } from './html.js';

export interface Identity {
  email: string;
  name?: string;
}

/** Trusts the typed email, so it is only ever enabled on localhost (see config). */
export class DevLoginProvider {
  constructor(private readonly config: Pick<Config, 'allowedDomain' | 'allowedEmails'>) {}

  renderForm({ action, next }: { action: string; next: string }): string {
    const hint = this.config.allowedEmails.length > 0
      ? 'one of the allowed addresses'
      : `an @${this.config.allowedDomain} address`;
    return `
      <form method="post" action="${escapeHtml(action)}">
        <input type="hidden" name="next" value="${escapeHtml(next)}">
        <label>Email <input type="email" name="email" required autofocus placeholder="${escapeHtml(hint)}"></label>
        <button type="submit">Sign in</button>
        <p class="muted">Development login: no password, localhost only.</p>
      </form>`;
  }

  async handleLogin(req: Request): Promise<Identity | { error: string }> {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!isAllowedEmail(this.config, email)) {
      return { error: 'That email address is not allowed to sign in here.' };
    }
    return { email, name: email.split('@')[0] };
  }
}

export const IAP_HEADER = 'x-goog-iap-jwt-assertion';
const IAP_ISSUER = 'https://cloud.google.com/iap';
const IAP_KEYS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';

/**
 * Identity-Aware Proxy has already signed the person in and checked IAM; every request it lets
 * through carries its signed assertion, verified here so that a request reaching the service some
 * other way proves nothing.
 */
export class IapLogin {
  private readonly keys: JWTVerifyGetKey;

  constructor(
    private readonly config: Pick<Config, 'allowedDomain' | 'allowedEmails'> & { iapAudience: string },
    keys?: JWTVerifyGetKey,
  ) {
    this.keys = keys ?? createRemoteJWKSet(new URL(IAP_KEYS_URL));
  }

  async identify(req: Request): Promise<Identity | null> {
    const assertion = req.headers[IAP_HEADER];
    if (typeof assertion !== 'string' || !assertion) {
      return null;
    }
    try {
      const { payload } = await jwtVerify(assertion, this.keys, {
        algorithms: ['ES256'],
        issuer: IAP_ISSUER,
        audience: this.config.iapAudience,
      });
      const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
      return isAllowedEmail(this.config, email) ? { email, name: email.split('@')[0] } : null;
    } catch {
      return null;
    }
  }
}
