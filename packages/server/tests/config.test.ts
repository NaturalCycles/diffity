import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ConfigError, isAllowedEmail, loadConfig } from '../src/config.js';
import { decrypt, encrypt, randomToken, safeEqual, sha256 } from '../src/crypto.js';

const key = randomBytes(32).toString('base64');

describe('loadConfig', () => {
  it('fills in the localhost defaults', () => {
    const config = loadConfig({ DIFFITY_DATA_DIR: '/data' });
    expect(config.publicUrl.href).toBe('http://localhost:5390/');
    expect(config.port).toBe(5390);
    expect(config.bindHost).toBe('127.0.0.1');
    expect(config.dataDir).toBe('/data');
    expect(config.allowedDomain).toBe('naturalcycles.com');
    expect(config.allowedEmails).toEqual([]);
    expect(config.devLogin).toBe(false);
    expect(config.devGitHubToken).toBeNull();
    expect(config.githubApiUrl).toBe('https://api.github.com');
    expect(config.secretKeyGenerated).toBe(true);
    expect(config.secretKey).toHaveLength(32);
  });

  it('reads every variable', () => {
    const config = loadConfig({
      DIFFITY_DATA_DIR: '/data',
      DIFFITY_PUBLIC_URL: 'http://127.0.0.1:8080',
      PORT: '8080',
      DIFFITY_SECRET_KEY: key,
      DIFFITY_DEV_LOGIN: 'true',
      DIFFITY_ALLOWED_DOMAIN: 'Example.COM',
      DIFFITY_ALLOWED_EMAILS: ' A@x.io, b@y.io ,',
      DIFFITY_DEV_GITHUB_TOKEN: 'ghp_x',
      GITHUB_API_URL: 'http://127.0.0.1:1/',
    });
    expect(config.port).toBe(8080);
    expect(config.bindHost).toBe('127.0.0.1');
    expect(config.secretKeyGenerated).toBe(false);
    expect(config.secretKey.toString('base64')).toBe(key);
    expect(config.devLogin).toBe(true);
    expect(config.allowedDomain).toBe('example.com');
    expect(config.allowedEmails).toEqual(['a@x.io', 'b@y.io']);
    expect(config.devGitHubToken).toBe('ghp_x');
    expect(config.githubApiUrl).toBe('http://127.0.0.1:1');
  });

  it('binds every interface for a public URL, or where told to', () => {
    expect(loadConfig({ DIFFITY_DATA_DIR: '/d', DIFFITY_PUBLIC_URL: 'https://d.example.com', DIFFITY_SECRET_KEY: key }).bindHost)
      .toBe('0.0.0.0');
    expect(loadConfig({ DIFFITY_DATA_DIR: '/d', DIFFITY_BIND: '0.0.0.0' }).bindHost).toBe('0.0.0.0');
  });

  it.each([
    [{}, 'DIFFITY_DATA_DIR is required'],
    [{ DIFFITY_DATA_DIR: '/d', DIFFITY_PUBLIC_URL: 'not a url' }, 'not a URL'],
    [{ DIFFITY_DATA_DIR: '/d', DIFFITY_PUBLIC_URL: 'ftp://x' }, 'http or https'],
    [{ DIFFITY_DATA_DIR: '/d', DIFFITY_PUBLIC_URL: 'https://x.io/sub' }, 'must be an origin'],
    [{ DIFFITY_DATA_DIR: '/d', PORT: 'abc' }, 'PORT must be'],
    [{ DIFFITY_DATA_DIR: '/d', DIFFITY_SECRET_KEY: 'c2hvcnQ=' }, '32 bytes'],
    [{ DIFFITY_DATA_DIR: '/d', DIFFITY_PUBLIC_URL: 'https://diffity.example.com' }, 'DIFFITY_SECRET_KEY is required'],
    [
      { DIFFITY_DATA_DIR: '/d', DIFFITY_PUBLIC_URL: 'https://diffity.example.com', DIFFITY_SECRET_KEY: key, DIFFITY_DEV_LOGIN: '1' },
      'DIFFITY_DEV_LOGIN is only allowed',
    ],
    [
      { DIFFITY_DATA_DIR: '/d', DIFFITY_PUBLIC_URL: 'https://diffity.example.com', DIFFITY_SECRET_KEY: key, DIFFITY_DEV_GITHUB_TOKEN: 't' },
      'DIFFITY_DEV_GITHUB_TOKEN is only allowed',
    ],
  ])('rejects %j', (env, message) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(message);
  });
});

describe('isAllowedEmail', () => {
  it('takes the domain rule when no list is given', () => {
    const config = { allowedDomain: 'naturalcycles.com', allowedEmails: [] };
    expect(isAllowedEmail(config, 'Fredrik@NaturalCycles.com')).toBe(true);
    expect(isAllowedEmail(config, 'someone@naturalcycles.com.evil.io')).toBe(false);
    expect(isAllowedEmail(config, 'someone@evilnaturalcycles.com')).toBe(false);
    expect(isAllowedEmail(config, 'not an email')).toBe(false);
  });

  it('lets an explicit list replace the domain', () => {
    const config = { allowedDomain: 'naturalcycles.com', allowedEmails: ['guest@x.io'] };
    expect(isAllowedEmail(config, 'guest@x.io')).toBe(true);
    expect(isAllowedEmail(config, 'fredrik@naturalcycles.com')).toBe(false);
  });
});

describe('crypto', () => {
  it('round-trips a sealed value and refuses another key or a tampered one', () => {
    const k = randomBytes(32);
    const sealed = encrypt(k, 'ghp_secret');
    expect(sealed).not.toContain('ghp_secret');
    expect(decrypt(k, sealed)).toBe('ghp_secret');
    expect(decrypt(randomBytes(32), sealed)).toBeNull();
    const raw = Buffer.from(sealed, 'base64');
    raw[raw.length - 1] ^= 1;
    expect(decrypt(k, raw.toString('base64'))).toBeNull();
  });

  it('makes opaque tokens and stable hashes', () => {
    expect(randomToken()).not.toBe(randomToken());
    expect(sha256('a')).toBe(sha256('a'));
    expect(sha256('a')).toHaveLength(64);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
