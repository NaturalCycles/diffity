import { randomBytes } from 'node:crypto';

export interface Config {
  publicUrl: URL;
  port: number;
  /**
   * Loopback by default for a localhost public URL, since the dev login trusts any typed email; a
   * container sets 0.0.0.0 and publishes the port.
   */
  bindHost: string;
  dataDir: string;
  secretKey: Buffer;
  /** True when no key was configured and one was made up for this run. */
  secretKeyGenerated: boolean;
  devLogin: boolean;
  allowedDomain: string;
  allowedEmails: string[];
  devGitHubToken: string | null;
  githubApiUrl: string;
}

export class ConfigError extends Error {}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK_HOSTNAMES.has(url.hostname);
}

function flag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

function parsePublicUrl(raw: string | undefined): URL {
  const text = raw?.trim() || 'http://localhost:5390';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(`DIFFITY_PUBLIC_URL is not a URL: ${text}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('DIFFITY_PUBLIC_URL must be http or https');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError('DIFFITY_PUBLIC_URL must be an origin, without a path, query or fragment');
  }
  return url;
}

function parsePort(raw: string | undefined): number {
  if (!raw?.trim()) {
    return 5390;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 0 and 65535, got ${raw}`);
  }
  return port;
}

function parseSecretKey(raw: string | undefined, publicUrl: URL): { key: Buffer; generated: boolean } {
  if (!raw?.trim()) {
    // Stored GitHub tokens cannot be read back after a restart with a different key, which is
    // acceptable on a laptop and never anywhere else.
    if (!isLoopbackUrl(publicUrl)) {
      throw new ConfigError('DIFFITY_SECRET_KEY is required when DIFFITY_PUBLIC_URL is not localhost');
    }
    return { key: randomBytes(32), generated: true };
  }
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    throw new ConfigError('DIFFITY_SECRET_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  }
  return { key, generated: false };
}

function parseEmails(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = parsePublicUrl(env.DIFFITY_PUBLIC_URL);
  const dataDir = env.DIFFITY_DATA_DIR?.trim();
  if (!dataDir) {
    throw new ConfigError('DIFFITY_DATA_DIR is required');
  }
  const devLogin = flag(env.DIFFITY_DEV_LOGIN);
  // The dev login trusts whatever email is typed, so it must never face the internet.
  if (devLogin && !isLoopbackUrl(publicUrl)) {
    throw new ConfigError('DIFFITY_DEV_LOGIN is only allowed when DIFFITY_PUBLIC_URL is localhost');
  }
  const devGitHubToken = env.DIFFITY_DEV_GITHUB_TOKEN?.trim() || null;
  // Shared by every user, so it would hand one person's repository access to all of them.
  if (devGitHubToken && !isLoopbackUrl(publicUrl)) {
    throw new ConfigError('DIFFITY_DEV_GITHUB_TOKEN is only allowed when DIFFITY_PUBLIC_URL is localhost');
  }
  const { key, generated } = parseSecretKey(env.DIFFITY_SECRET_KEY, publicUrl);

  return {
    publicUrl,
    port: parsePort(env.PORT),
    bindHost: env.DIFFITY_BIND?.trim() || (isLoopbackUrl(publicUrl) ? '127.0.0.1' : '0.0.0.0'),
    dataDir,
    secretKey: key,
    secretKeyGenerated: generated,
    devLogin,
    allowedDomain: (env.DIFFITY_ALLOWED_DOMAIN?.trim() || 'naturalcycles.com').toLowerCase(),
    allowedEmails: parseEmails(env.DIFFITY_ALLOWED_EMAILS),
    devGitHubToken,
    githubApiUrl: (env.GITHUB_API_URL?.trim() || 'https://api.github.com').replace(/\/+$/, ''),
  };
}

/** An explicit allow-list replaces the domain rule rather than adding to it. */
export function isAllowedEmail(config: Pick<Config, 'allowedDomain' | 'allowedEmails'>, email: string): boolean {
  const normalised = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(normalised)) {
    return false;
  }
  if (config.allowedEmails.length > 0) {
    return config.allowedEmails.includes(normalised);
  }
  return normalised.endsWith(`@${config.allowedDomain}`);
}
