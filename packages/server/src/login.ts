import type { Request } from 'express';
import { isAllowedEmail, type Config } from './config.js';
import { escapeHtml } from './html.js';

export type LoginResult = { email: string; name?: string } | { error: string };

/**
 * How a person proves who they are. Phase 1 has only the dev login; Firebase Google sign-in slots
 * in as another implementation, verifying an ID token in `handleLogin`.
 */
export interface LoginProvider {
  /** The inside of the login page's form area; `action` is where it must POST. */
  renderForm(input: { action: string; next: string }): string;
  handleLogin(req: Request): Promise<LoginResult>;
}

/** Trusts the typed email, so it is only ever enabled on localhost (see config). */
export class DevLoginProvider implements LoginProvider {
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

  async handleLogin(req: Request): Promise<LoginResult> {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!isAllowedEmail(this.config, email)) {
      return { error: 'That email address is not allowed to sign in here.' };
    }
    return { email, name: email.split('@')[0] };
  }
}
