import { describe, expect, it } from 'vitest';
import type { BundleThread } from '@diffity/api';
import {
  UsageError,
  bundleNamesFor,
  candidateLabel,
  compareFindings,
  findingsOf,
  firstSentence,
  formatTokens,
  matches,
  newestBundle,
  parseOptions,
  parsePrSpec,
  renderMarkdown,
  renderSpend,
  sameHead,
  spendOf,
  type Finding,
} from './inbox-compare.js';

const AGENT = { name: 'agent', type: 'agent' } as const;

const REF = { owner: 'NaturalCycles', repo: 'NCBackend3', number: 14550 };

function finding(over: Partial<Finding> = {}): Finding {
  return { severity: 'P1', filePath: 'src/a.ts', startLine: 10, endLine: 10, sentence: 'Something is off.', ...over };
}

function thread(over: Partial<BundleThread> = {}): BundleThread {
  return {
    filePath: 'src/a.ts',
    side: 'new',
    startLine: 10,
    endLine: 12,
    status: 'open',
    anchorContent: null,
    comments: [{ author: AGENT, body: 'P1: it breaks. And more.', kind: 'review', createdAt: '2026-09-07T08:00:00.000Z' }],
    ...over,
  };
}

describe('parseOptions', () => {
  it('takes the pull request and leaves the defaults', () => {
    const options = parseOptions(['NaturalCycles/NCBackend3#14550']);

    expect(options.ref).toEqual(REF);
    expect(options.head).toBeNull();
    expect(options.model).toBeNull();
    expect(options.json).toBe(false);
    expect(options.keep).toBe(false);
    expect(options.bundlesDir).toMatch(/\/\.diffity\/inbox\/bundles$/);
    expect(options.reposDir).toMatch(/\/nc\/repos$/);
    expect(options.scratch).toBeNull();
  });

  it('reads every flag', () => {
    const options = parseOptions([
      'o/r#7', '--head', 'ABCDEF1234567', '--model', 'opus', '--effort', 'medium',
      '--bundles-dir', '/b', '--repos-dir', '/r', '--scratch', '/s', '--out', '/o.md', '--json', '--keep',
    ]);

    expect(options).toEqual({
      ref: { owner: 'o', repo: 'r', number: 7 },
      head: 'ABCDEF1234567',
      model: 'opus',
      effort: 'medium',
      bundlesDir: '/b',
      reposDir: '/r',
      scratch: '/s',
      out: '/o.md',
      json: true,
      keep: true,
    });
  });

  it('refuses what it cannot act on', () => {
    expect(() => parseOptions([])).toThrow(UsageError);
    expect(() => parseOptions(['o/r#1', '--nope'])).toThrow(/unknown option --nope/);
    expect(() => parseOptions(['o/r#1', 'o/r#2'])).toThrow(/one pull request at a time/);
    expect(() => parseOptions(['o/r#1', '--model'])).toThrow(/--model needs a value/);
    expect(() => parseOptions(['o/r#1', '--model', '--json'])).toThrow(/--model needs a value/);
    expect(() => parseOptions(['o/r#1', '--effort', 'gentle'])).toThrow(/low\|medium\|high\|xhigh\|max/);
    expect(() => parseOptions(['o/r#1', '--head', 'zzz'])).toThrow(/at least 7 hex digits/);
  });
});

describe('parsePrSpec', () => {
  it('reads owner, repository and number', () => {
    expect(parsePrSpec('NaturalCycles/NCBackend3#14550')).toEqual(REF);
  });

  it('refuses anything else', () => {
    for (const spec of ['NCBackend3#1', 'o/r', 'o/r#', 'o/r#x', '#1']) {
      expect(() => parsePrSpec(spec)).toThrow(UsageError);
    }
  });
});

describe('bundleNamesFor', () => {
  it('keeps the pull request its own, dashes in the names and all', () => {
    const names = [
      'NaturalCycles-NCBackend3-14550-879ffcdc4ebf.json',
      'NaturalCycles-NCBackend3-14550-0e0e0c6ba442.json',
      'NaturalCycles-NCBackend3-1455-879ffcdc4ebf.json',
      'NaturalCycles-NCBackend3-145500-879ffcdc4ebf.json',
      'NaturalCycles-admin3-14550-879ffcdc4ebf.json',
      'NaturalCycles-NCBackend3-14550-879ffcdc4ebf.log',
      'NaturalCycles-NCBackend3-14550-notahash.json',
    ];

    expect(bundleNamesFor(names, REF)).toEqual([
      'NaturalCycles-NCBackend3-14550-879ffcdc4ebf.json',
      'NaturalCycles-NCBackend3-14550-0e0e0c6ba442.json',
    ]);
  });
});

describe('newestBundle', () => {
  const bundles = [
    { path: '/b/old.json', headSha: 'aaaaaaaaaaaa1111', createdAt: '2026-09-01T10:00:00.000Z' },
    { path: '/b/new.json', headSha: 'bbbbbbbbbbbb2222', createdAt: '2026-09-07T10:00:00.000Z' },
    { path: '/b/mid.json', headSha: 'aaaaaaaaaaaa1111', createdAt: '2026-09-03T10:00:00.000Z' },
  ];

  it('takes the newest when no head is named', () => {
    expect(newestBundle(bundles, null)?.path).toBe('/b/new.json');
  });

  it('takes the newest at the named head', () => {
    expect(newestBundle(bundles, 'aaaaaaaaaaaa')?.path).toBe('/b/mid.json');
  });

  it('is null when nothing is at that head', () => {
    expect(newestBundle(bundles, 'cccccccccccc')).toBeNull();
    expect(newestBundle([], null)).toBeNull();
  });
});

describe('sameHead', () => {
  it('compares on the shorter sha', () => {
    expect(sameHead('879ffcdc4ebf09fec4466d6c2c8b94d6909e282b', '879ffcdc4ebf')).toBe(true);
    expect(sameHead('879FFCDC4EBF', '879ffcdc4ebf09fe')).toBe(true);
    expect(sameHead('879ffcdc4ebf', '879ffcdc0000')).toBe(false);
  });

  it('will not call six digits a match', () => {
    expect(sameHead('879ffc', '879ffcdc4ebf')).toBe(false);
  });
});

describe('findingsOf', () => {
  it('labels each finding by the severity it opens with', () => {
    const findings = findingsOf([
      thread(),
      thread({ filePath: 'docs/x.md', startLine: 40, endLine: 40, comments: [{ author: AGENT, body: '[suggestion] rename it.', kind: 'review', createdAt: '2026-09-07T08:00:00.000Z' }] }),
      thread({ comments: [{ author: AGENT, body: 'no marker at all.', kind: 'review', createdAt: '2026-09-07T08:00:00.000Z' }] }),
    ]);

    expect(findings.map(item => item.severity)).toEqual(['P1', 'suggestion', 'other']);
    expect(findings[0]).toEqual({ severity: 'P1', filePath: 'src/a.ts', startLine: 10, endLine: 12, sentence: 'it breaks.' });
  });

  it('leaves out the general summary and the threads nobody has to act on', () => {
    const findings = findingsOf([
      thread(),
      thread({ filePath: '__general__', startLine: 0, endLine: 0 }),
      thread({ filePath: 'src/b.ts', status: 'dismissed' }),
      thread({ filePath: 'src/c.ts', status: 'resolved' }),
    ]);

    expect(findings.map(item => item.filePath)).toEqual(['src/a.ts']);
  });

  it('takes the review comment rather than whatever was added later', () => {
    const findings = findingsOf([thread({
      comments: [
        { author: AGENT, body: 'a note.', kind: 'aside', createdAt: '2026-09-07T08:00:00.000Z' },
        { author: AGENT, body: 'P2: the real finding.', kind: 'review', createdAt: '2026-09-07T08:01:00.000Z' },
      ],
    })]);

    expect(findings[0].severity).toBe('P2');
    expect(findings[0].sentence).toBe('the real finding.');
  });
});

describe('firstSentence', () => {
  it('drops the severity marker', () => {
    expect(firstSentence('P1: this is wrong. And this too.')).toBe('this is wrong.');
    expect(firstSentence('[must-fix] this is wrong.')).toBe('this is wrong.');
  });

  it('does not break a sentence on a decimal point', () => {
    expect(firstSentence('P3: the threshold is 0.197 here. The other one differs.')).toBe('the threshold is 0.197 here.');
  });

  it('collapses the newlines a finding is written over', () => {
    expect(firstSentence('P2: one\n   two three')).toBe('one two three');
  });

  it('cuts a long opening', () => {
    expect(firstSentence(`P1: ${'x'.repeat(300)}`, 20)).toBe(`${'x'.repeat(20)}…`);
  });
});

describe('matches', () => {
  it('needs the same file', () => {
    expect(matches(finding(), finding({ filePath: 'src/b.ts' }))).toBe(false);
  });

  it('allows a one-line finding two lines of slack either way', () => {
    expect(matches(finding(), finding({ startLine: 12, endLine: 12 }))).toBe(true);
    expect(matches(finding(), finding({ startLine: 14, endLine: 14 }))).toBe(true);
    expect(matches(finding(), finding({ startLine: 15, endLine: 15 }))).toBe(false);
  });

  it('takes a range as written', () => {
    const range = finding({ startLine: 20, endLine: 30 });

    expect(matches(range, finding({ startLine: 30, endLine: 40 }))).toBe(true);
    expect(matches(range, finding({ startLine: 31, endLine: 40 }))).toBe(false);
    expect(matches(range, finding({ startLine: 32, endLine: 32 }))).toBe(true);
  });
});

describe('compareFindings', () => {
  const spend = { costUsd: 1.2, minutes: 6.1, turns: 22, outputTokens: 14_000 };

  function compare(baseline: Finding[], drafted: Finding[]) {
    return compareFindings({ pr: 'o/r#1', head: '879ffcdc4ebf', candidate: 'opus', baseline, drafted, spend });
  }

  it('counts reproduced against the baseline and new against the candidate', () => {
    const comparison = compare(
      [
        finding({ severity: 'P1', filePath: 'src/a.ts', startLine: 12, endLine: 14 }),
        finding({ severity: 'P2', filePath: 'docs/x.md', startLine: 40, endLine: 40 }),
        finding({ severity: 'P3', filePath: 'src/c.ts', startLine: 5, endLine: 5 }),
      ],
      [
        finding({ severity: 'P1', filePath: 'src/a.ts', startLine: 12, endLine: 12 }),
        finding({ severity: 'P3', filePath: 'src/c.ts', startLine: 6, endLine: 6 }),
        finding({ severity: 'P2', filePath: 'src/x.ts', startLine: 80, endLine: 80 }),
        finding({ severity: 'P3', filePath: 'src/y.ts', startLine: 1, endLine: 1 }),
        finding({ severity: 'P3', filePath: 'src/z.ts', startLine: 1, endLine: 1 }),
      ],
    );

    expect(comparison.severities).toEqual([
      { severity: 'P1', baseline: 1, reproduced: 1, added: 0 },
      { severity: 'P2', baseline: 1, reproduced: 0, added: 1 },
      { severity: 'P3', baseline: 1, reproduced: 1, added: 2 },
    ]);
    expect(comparison.baseline.map(row => row.reproducedBy?.filePath ?? null)).toEqual(['src/a.ts', null, 'src/c.ts']);
    expect(comparison.added.map(row => row.filePath)).toEqual(['src/x.ts', 'src/y.ts', 'src/z.ts']);
  });

  it('lists only the severities either side has', () => {
    const comparison = compare([finding({ severity: 'P1' })], [finding({ severity: 'other', filePath: 'src/q.ts' })]);

    expect(comparison.severities.map(row => row.severity)).toEqual(['P1', 'other']);
  });

  it('matches on the lines whatever the severities say', () => {
    const comparison = compare([finding({ severity: 'P1' })], [finding({ severity: 'P3' })]);

    expect(comparison.severities).toEqual([{ severity: 'P1', baseline: 1, reproduced: 1, added: 0 }]);
    expect(comparison.baseline[0].reproducedBy?.severity).toBe('P3');
    expect(comparison.added).toEqual([]);
  });

  it('carries what the run spent through', () => {
    expect(compare([], []).spend).toEqual(spend);
  });
});

describe('spendOf', () => {
  it('is all unknown when the agent reported nothing', () => {
    expect(spendOf(null)).toEqual({ costUsd: null, minutes: null, turns: null, outputTokens: null });
  });

  it('reads minutes out of the duration', () => {
    const spend = spendOf({
      costUsd: 1.2, durationMs: 366_000, turns: 22, inputTokens: 100, outputTokens: 14_000,
      cacheReadTokens: 0, cacheWriteTokens: 0, models: ['opus'], isError: false, subtype: 'success',
    });

    expect(spend).toEqual({ costUsd: 1.2, minutes: 6.1, turns: 22, outputTokens: 14_000 });
  });
});

describe('renderSpend', () => {
  it('writes an unknown as a dash', () => {
    expect(renderSpend({ costUsd: null, minutes: null, turns: null, outputTokens: null })).toBe('— / — / — / —');
  });

  it('writes what is known', () => {
    expect(renderSpend({ costUsd: 1.2, minutes: 6.14, turns: 22, outputTokens: 14_400 })).toBe('$1.20 / 6.1 min / 22 turns / 14k out');
  });
});

describe('formatTokens', () => {
  it('rounds to thousands once there are thousands', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1499)).toBe('1k');
    expect(formatTokens(27_400)).toBe('27k');
  });
});

describe('candidateLabel', () => {
  it('names the model, or says it is the default one', () => {
    expect(candidateLabel('opus', null)).toBe('opus');
    expect(candidateLabel(null, null)).toBe('default model');
    expect(candidateLabel(null, 'medium')).toBe('default model · effort medium');
  });
});

describe('renderMarkdown', () => {
  it('renders the block to paste into the issue', () => {
    const comparison = compareFindings({
      pr: 'NaturalCycles/NCBackend3#14550',
      head: '879ffcdc4ebf',
      candidate: 'opus',
      baseline: [
        finding({ severity: 'P1', filePath: 'src/b1/config.ts', startLine: 12, endLine: 14, sentence: 'the baseline is stale.' }),
        finding({ severity: 'P2', filePath: 'docs/vogon/b1Service.md', startLine: 40, endLine: 40, sentence: 'the document is not updated.' }),
      ],
      drafted: [
        finding({ severity: 'P1', filePath: 'src/b1/config.ts', startLine: 12, endLine: 12, sentence: 'the baseline is stale.' }),
        finding({ severity: 'P2', filePath: 'src/x.ts', startLine: 80, endLine: 80, sentence: 'this leaks.' }),
      ],
      spend: { costUsd: 1.2, minutes: 6.1, turns: 22, outputTokens: 14_000 },
    });

    expect(renderMarkdown(comparison)).toBe([
      '### NaturalCycles/NCBackend3#14550 · head 879ffcdc4ebf · candidate: opus',
      '| | baseline (Fable, old pipeline) | candidate |',
      '|---|---|---|',
      '| P1 | 1 | 1 reproduced, 0 new |',
      '| P2 | 1 | 0 reproduced, 1 new |',
      '| cost / time | — | $1.20 / 6.1 min / 22 turns / 14k out |',
      '',
      'Baseline findings:',
      '- P1 src/b1/config.ts:12-14 — the baseline is stale. → reproduced by P1 src/b1/config.ts:12',
      '- P2 docs/vogon/b1Service.md:40 — the document is not updated. → not reproduced',
      'New in candidate:',
      '- P2 src/x.ts:80 — this leaks.',
      '',
    ].join('\n'));
  });

  it('says so when a side found nothing', () => {
    const comparison = compareFindings({
      pr: 'o/r#1', head: 'abcdef123456', candidate: 'default model',
      baseline: [], drafted: [], spend: spendOf(null),
    });

    expect(renderMarkdown(comparison)).toContain('Baseline findings:\n- none\nNew in candidate:\n- none');
    expect(renderMarkdown(comparison)).toContain('| cost / time | — | — / — / — / — |');
  });
});

describe('the JSON shape', () => {
  it('survives a round trip through JSON', () => {
    const comparison = compareFindings({
      pr: 'o/r#1', head: 'abcdef123456', candidate: 'opus',
      baseline: [finding()],
      drafted: [finding({ severity: 'P2', startLine: 11, endLine: 11 })],
      spend: { costUsd: 1.2, minutes: 6.1, turns: 22, outputTokens: 14_000 },
    });

    expect(JSON.parse(JSON.stringify(comparison))).toEqual({
      pr: 'o/r#1',
      head: 'abcdef123456',
      candidate: 'opus',
      severities: [{ severity: 'P1', baseline: 1, reproduced: 1, added: 0 }],
      baseline: [{
        severity: 'P1', filePath: 'src/a.ts', startLine: 10, endLine: 10, sentence: 'Something is off.',
        reproducedBy: { severity: 'P2', filePath: 'src/a.ts', startLine: 11, endLine: 11, sentence: 'Something is off.' },
      }],
      added: [],
      spend: { costUsd: 1.2, minutes: 6.1, turns: 22, outputTokens: 14_000 },
    });
  });
});
