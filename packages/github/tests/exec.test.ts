import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { gh, ghAsync } from '../src/exec.js';
import { pullThreadState } from '../src/pr.js';

let fakeBin: string;
let origPath: string | undefined;

// A fake gh ahead on PATH, so the tests decide what "gh" says without a network or an account.
beforeAll(() => {
  fakeBin = mkdtempSync(join(tmpdir(), 'diffity-fake-gh-'));
  writeFileSync(join(fakeBin, 'gh'), [
    '#!/bin/sh',
    'if [ -n "$FAKE_GH_STDERR" ]; then printf \'%s\\n\' "$FAKE_GH_STDERR" >&2; fi',
    'if [ -n "$FAKE_GH_ECHO_STDIN" ]; then cat; fi',
    'if [ -n "$FAKE_GH_STDOUT" ]; then printf \'%s\\n\' "$FAKE_GH_STDOUT"; fi',
    'exit "${FAKE_GH_EXIT:-0}"',
    '',
  ].join('\n'));
  chmodSync(join(fakeBin, 'gh'), 0o755);
  origPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${delimiter}${origPath ?? ''}`;
});

afterAll(() => {
  if (origPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = origPath;
  }
  delete process.env.FAKE_GH_EXIT;
  delete process.env.FAKE_GH_STDERR;
  delete process.env.FAKE_GH_STDOUT;
  rmSync(fakeBin, { recursive: true, force: true });
});

describe('what a gh failure says', () => {
  it('carries the reason from stderr, not just "Command failed"', () => {
    process.env.FAKE_GH_EXIT = '1';
    process.env.FAKE_GH_STDERR = 'HTTP 401: Bad credentials (https://api.github.com/user)';
    process.env.FAKE_GH_STDOUT = '';

    expect(() => gh(['api', 'user']))
      .toThrowError('gh api user failed: HTTP 401: Bad credentials (https://api.github.com/user)');
  });

  it('still says which call failed when stderr is empty', () => {
    process.env.FAKE_GH_EXIT = '3';
    process.env.FAKE_GH_STDERR = '';
    process.env.FAKE_GH_STDOUT = '';

    expect(() => gh(['pr', 'view'])).toThrowError(/^gh pr view failed: /);
  });
});

describe('what pullThreadState answers', () => {
  it('a GraphQL answer with no data is "could not ask", not "no threads"', async () => {
    process.env.FAKE_GH_EXIT = '0';
    process.env.FAKE_GH_STDERR = '';
    process.env.FAKE_GH_STDOUT = '{"data":null,"errors":[{"message":"SAML enforcement"}]}';

    await expect(pullThreadState('o', 'r', 1)).resolves.toBeNull();
  });

  it('an empty thread list is a real answer', async () => {
    process.env.FAKE_GH_EXIT = '0';
    process.env.FAKE_GH_STDERR = '';
    process.env.FAKE_GH_STDOUT = '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}';

    await expect(pullThreadState('o', 'r', 1)).resolves.toEqual([]);
  });

  it('a failed call is null too', async () => {
    process.env.FAKE_GH_EXIT = '1';
    process.env.FAKE_GH_STDERR = 'gh: Not Found (HTTP 404)';
    process.env.FAKE_GH_STDOUT = '';

    await expect(pullThreadState('o', 'r', 1)).resolves.toBeNull();
  });
});

describe('the async twin', () => {
  it('fails with the same shape, preferring the gh: line over noise before it', async () => {
    process.env.FAKE_GH_EXIT = '1';
    process.env.FAKE_GH_STDERR = 'some progress chatter\ngh: Validation Failed (HTTP 422)';
    process.env.FAKE_GH_STDOUT = '';

    await expect(ghAsync(['api', 'user'])).rejects.toThrowError(
      'gh api user failed: gh: Validation Failed (HTTP 422)',
    );
  });

  it('hands stdin through and answers with stdout', async () => {
    process.env.FAKE_GH_EXIT = '0';
    process.env.FAKE_GH_STDERR = '';
    process.env.FAKE_GH_STDOUT = '';
    process.env.FAKE_GH_ECHO_STDIN = '1';

    await expect(ghAsync(['api', 'x', '--input', '-'], { input: '{"a":1}' })).resolves.toBe('{"a":1}');
    delete process.env.FAKE_GH_ECHO_STDIN;
  });
});
