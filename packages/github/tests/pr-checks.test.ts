import { describe, it, expect } from 'vitest';
import { ciState, parseChecks, parseFiles, parsePrSnapshot, MAX_SNAPSHOT_FILES } from '../src/inbox.js';

const ref = { owner: 'o', repo: 'r', number: 1 };

/** A check run as `gh pr view --json statusCheckRollup` gives one. */
function run(name: string, status: string, conclusion: string | null) {
  return { __typename: 'CheckRun', name, status, conclusion, workflowName: 'ci' };
}

/** A commit status, which the same field mixes in with the check runs. */
function context(name: string, state: string) {
  return { __typename: 'StatusContext', context: name, state };
}

describe('parseChecks', () => {
  it('reads check runs and commit statuses alike', () => {
    expect(parseChecks([
      run('check-job', 'COMPLETED', 'SUCCESS'),
      run('e2e', 'IN_PROGRESS', null),
      run('deploy', 'QUEUED', null),
      run('integration-test-job', 'COMPLETED', 'SKIPPED'),
      run('lint', 'COMPLETED', 'NEUTRAL'),
      run('build', 'COMPLETED', 'TIMED_OUT'),
      run('release', 'COMPLETED', 'CANCELLED'),
      run('docs', 'COMPLETED', 'STALE'),
      context('vercel', 'SUCCESS'),
      context('legacy', 'ERROR'),
      context('waiting', 'PENDING'),
    ])).toEqual([
      { name: 'check-job', status: 'success' },
      { name: 'e2e', status: 'pending' },
      { name: 'deploy', status: 'pending' },
      { name: 'integration-test-job', status: 'skipped' },
      { name: 'lint', status: 'neutral' },
      { name: 'build', status: 'failure' },
      { name: 'release', status: 'neutral' },
      { name: 'docs', status: 'neutral' },
      { name: 'vercel', status: 'success' },
      { name: 'legacy', status: 'failure' },
      { name: 'waiting', status: 'pending' },
    ]);
  });

  it('lets a re-run\'s success outrank the attempt that was cancelled or superseded', () => {
    // A cancelled or stale run decided nothing, so the run that did decide is the head's verdict.
    for (const undecided of ['CANCELLED', 'STALE']) {
      const checks = parseChecks([run('check-job', 'COMPLETED', undecided), run('check-job', 'COMPLETED', 'SUCCESS')]);
      expect(checks).toEqual([{ name: 'check-job', status: 'success' }]);
      expect(ciState(checks)).toBe('passing');
    }
    // A real failure still outranks a success at the same name: something is wrong with the code.
    expect(parseChecks([run('check-job', 'COMPLETED', 'TIMED_OUT'), run('check-job', 'COMPLETED', 'SUCCESS')]))
      .toEqual([{ name: 'check-job', status: 'failure' }]);
  });

  it('keeps one entry per name, at its worst report', () => {
    // A workflow triggered several times, or re-run: the failure is the one that matters.
    expect(parseChecks([
      run('check-job', 'COMPLETED', 'SUCCESS'),
      run('check-job', 'COMPLETED', 'FAILURE'),
      run('check-job', 'COMPLETED', 'SUCCESS'),
      run('doc', 'COMPLETED', 'SKIPPED'),
      run('doc', 'IN_PROGRESS', null),
    ])).toEqual([
      { name: 'check-job', status: 'failure' },
      { name: 'doc', status: 'pending' },
    ]);
  });

  it('takes nothing from a field that is missing or malformed', () => {
    expect(parseChecks(undefined)).toEqual([]);
    expect(parseChecks(null)).toEqual([]);
    expect(parseChecks('SUCCESS')).toEqual([]);
    expect(parseChecks([null, 42, {}, { name: '' }])).toEqual([]);
  });
});

describe('parseFiles', () => {
  it('reads the changed paths and their counts, and caps a huge diff', () => {
    expect(parseFiles([{ path: 'src/a.ts', additions: 3, deletions: 1 }, { path: 'b.ts' }]))
      .toEqual([{ path: 'src/a.ts', additions: 3, deletions: 1 }, { path: 'b.ts', additions: 0, deletions: 0 }]);

    const many = Array.from({ length: 500 }, (_, i) => ({ path: `f${i}.ts`, additions: 1, deletions: 0 }));
    const files = parseFiles(many);
    expect(files).toHaveLength(MAX_SNAPSHOT_FILES);
    expect(files.at(-1)!.path).toBe(`f${MAX_SNAPSHOT_FILES - 1}.ts`);
  });

  it('takes nothing from a field that is missing or malformed', () => {
    expect(parseFiles(undefined)).toEqual([]);
    expect(parseFiles([null, { path: 1 }, { path: '' }])).toEqual([]);
  });
});

describe('ciState', () => {
  it('is one word for the whole set of checks', () => {
    expect(ciState([])).toBe('none');
    expect(ciState([{ name: 'a', status: 'success' }, { name: 'b', status: 'skipped' }])).toBe('passing');
    // Nothing here decided anything, so there is nothing to call green.
    expect(ciState([{ name: 'a', status: 'skipped' }, { name: 'b', status: 'neutral' }])).toBe('none');
    expect(ciState(parseChecks([run('check-job', 'COMPLETED', 'CANCELLED')]))).toBe('none');
    expect(ciState([{ name: 'a', status: 'success' }, { name: 'b', status: 'pending' }])).toBe('running');
    // A failure outranks a run still going: there is already something to fix.
    expect(ciState([{ name: 'a', status: 'pending' }, { name: 'b', status: 'failure' }])).toBe('failing');
  });
});

describe('parsePrSnapshot', () => {
  const base = {
    title: 'T', url: 'https://github.com/o/r/pull/1', author: { login: 'alice' },
    isDraft: false, state: 'OPEN', headRefOid: 'abc', baseRefName: 'main',
    additions: 1, deletions: 0, changedFiles: 1, createdAt: 'now', updatedAt: 'now',
  };

  it('carries what CI said and which files changed', () => {
    const snapshot = parsePrSnapshot(ref, JSON.stringify({
      ...base,
      statusCheckRollup: [run('check-job', 'COMPLETED', 'FAILURE')],
      files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }],
    }));
    expect(snapshot?.checks).toEqual([{ name: 'check-job', status: 'failure' }]);
    expect(snapshot?.files).toEqual([{ path: 'src/a.ts', additions: 1, deletions: 0 }]);
  });

  it('leaves both empty when gh does not report them', () => {
    // An older gh, or a repository with no checks at all.
    const snapshot = parsePrSnapshot(ref, JSON.stringify(base));
    expect(snapshot?.checks).toEqual([]);
    expect(snapshot?.files).toEqual([]);
  });
});
