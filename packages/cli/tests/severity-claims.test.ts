import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GENERAL_THREAD_FILE_PATH } from '@diffity/api';
import { claimedSeverities, unbackedBundleClaims, unbackedClaims } from '../src/inbox/severity-claims.js';
import type { FindingThread } from '../src/inbox/summary.js';

/** One finding, as either a bundle or a live session presents one. */
function finding(body: string, over: Partial<FindingThread> = {}): FindingThread {
  return { filePath: 'a.ts', status: 'open', comments: [{ body, kind: 'review' }], ...over };
}

describe('claimedSeverities', () => {
  it('finds every severity the prose asserts, once each, in either vocabulary', () => {
    expect(claimedSeverities('and a new P1 beside the p2, plus a must-fix and the P1 again'))
      .toEqual(['P1', 'P2', 'must-fix']);
    expect(claimedSeverities('nothing about severity here')).toEqual([]);
    expect(claimedSeverities('')).toEqual([]);
  });

  it('leaves out a mention that is denied', () => {
    expect(claimedSeverities('no P1 in this change')).toEqual([]);
    expect(claimedSeverities('there is not a P1 here')).toEqual([]);
    expect(claimedSeverities('solid, without a must-fix anywhere')).toEqual([]);
    expect(claimedSeverities('zero P2 findings')).toEqual([]);
  });

  it('still reads a mention the denial does not reach as a claim', () => {
    // A denial only counts close by and inside the same sentence, which is the heuristic's whole
    // shape: "no" about something else must not excuse a claim made after it.
    expect(claimedSeverities('no tests are missing, but there is a P1 in the parser')).toEqual(['P1']);
    expect(claimedSeverities('nothing is wrong with the naming. A P1 sits in the guard')).toEqual(['P1']);
    expect(claimedSeverities('P1: the token is logged')).toEqual(['P1']);
  });

  it('reads a plural as the claim it is, which is how a count is written', () => {
    expect(claimedSeverities('two P1s remain')).toEqual(['P1']);
    expect(claimedSeverities('three must-fixes and a P2')).toEqual(['must-fix', 'P2']);
  });

  it('leaves out a plural that is denied', () => {
    expect(claimedSeverities('no P1s here')).toEqual([]);
    expect(claimedSeverities('without must-fixes')).toEqual([]);
  });

  it('does not take a severity inside a longer word for a claim', () => {
    expect(claimedSeverities('the P12 experiment and the must-fixture helper')).toEqual([]);
  });
});

describe('unbackedClaims', () => {
  it('is empty when a finding carries the claimed severity', () => {
    expect(unbackedClaims('a new P1 in the token path', [finding('P1: the token is logged')])).toEqual([]);
  });

  it('names the severity the findings do not carry, however the prose counts them', () => {
    expect(unbackedClaims('and a new P1', [finding('P2: this reads oddly')])).toEqual(['P1']);
    expect(unbackedClaims('a P1 and a must-fix', [finding('P2: this reads oddly')])).toEqual(['P1', 'must-fix']);
    expect(unbackedClaims('two P1s remain', [finding('P2: this reads oddly')])).toEqual(['P1']);
    expect(unbackedClaims('no P1s here', [finding('P2: this reads oddly')])).toEqual([]);
  });

  it('counts only findings the reviewer still has to act on, by the summary\'s own rules', () => {
    // A dismissed finding backs nothing; nor does the general summary, which is prose itself.
    expect(unbackedClaims('a P1', [finding('P1: this does not hold', { status: 'dismissed' })])).toEqual(['P1']);
    expect(unbackedClaims('a P1', [finding('P1: in the summary', { filePath: GENERAL_THREAD_FILE_PATH })])).toEqual(['P1']);
    expect(unbackedClaims('a P1', [])).toEqual(['P1']);
  });

  it('reads the finding a thread opens with when the comments carry no kind', () => {
    // What `agent list` reports has no comment kinds at all, and must still back a claim.
    expect(unbackedClaims('a P1', [{ filePath: 'a.ts', status: 'open', comments: [{ body: 'P1: the token is logged' }] }]))
      .toEqual([]);
  });
});

describe('unbackedBundleClaims', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'diffity-claims-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function bundle(over: Record<string, unknown>): string {
    const path = join(dir, 'bundle.json');
    writeFileSync(path, JSON.stringify({ threads: [], tours: [], ...over }));
    return path;
  }

  const p2 = {
    filePath: 'a.ts', status: 'open',
    comments: [{ body: 'P2: this reads oddly', kind: 'review', author: { name: 'Agent', type: 'agent' }, createdAt: '' }],
  };

  it('reads the general summary and finds a claim nothing carries', () => {
    const path = bundle({
      threads: [p2, { ...p2, filePath: GENERAL_THREAD_FILE_PATH, comments: [{ ...p2.comments[0], body: 'Two nits and a new P1.' }] }],
    });

    expect(unbackedBundleClaims(path)).toEqual(['P1']);
  });

  it('reads the walkthrough — topic, body, step bodies and step annotations', () => {
    const withTour = (steps: unknown[]) => bundle({
      threads: [p2], tours: [{ topic: 'Reading order', body: '', status: 'ready', steps }],
    });

    expect(unbackedBundleClaims(withTour([{ filePath: 'a.ts', startLine: 1, endLine: 1, body: '', annotation: 'where the P1 lives' }])))
      .toEqual(['P1']);
    expect(unbackedBundleClaims(withTour([{ filePath: 'a.ts', startLine: 1, endLine: 1, body: 'the must-fix is here', annotation: '' }])))
      .toEqual(['must-fix']);
    expect(unbackedBundleClaims(bundle({ threads: [p2], tours: [{ topic: 'The P1 path', body: '', status: 'ready', steps: [] }] })))
      .toEqual(['P1']);
  });

  it('is empty when the prose and the findings agree, and for a file that is no bundle', () => {
    const p1 = { ...p2, comments: [{ ...p2.comments[0], body: 'P1: the token is logged' }] };
    expect(unbackedBundleClaims(bundle({
      threads: [p1], tours: [{ topic: 'Reading order', body: 'One P1 in the token path.', status: 'ready', steps: [] }],
    }))).toEqual([]);

    const notABundle = join(dir, 'nope.json');
    writeFileSync(notABundle, '{"nothing":true}');
    expect(unbackedBundleClaims(notABundle)).toEqual([]);
    expect(unbackedBundleClaims(join(dir, 'missing.json'))).toEqual([]);
  });
});
