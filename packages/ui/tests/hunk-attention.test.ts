import { describe, it, expect } from 'vitest';
import type { DiffFile, DiffHunk, DiffLine } from '@diffity/parser';
import {
  classifyHunk,
  hunkIntersectsRanges,
  isImportOnlyHunk,
  isIndentationSensitive,
  isWhitespaceOnlyHunk,
} from '../src/lib/hunk-attention';

function line(type: DiffLine['type'], content: string): DiffLine {
  return { type, content, oldLineNumber: null, newLineNumber: null };
}

function hunk(lines: DiffLine[]): DiffHunk {
  return { header: '@@ -1,3 +1,3 @@', oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines };
}

function file(path: string, hunks: DiffHunk[] = []): DiffFile {
  return {
    oldPath: path,
    newPath: path,
    status: 'modified',
    hunks,
    additions: 1,
    deletions: 1,
    isBinary: false,
  };
}

describe('isWhitespaceOnlyHunk', () => {
  it('sees a reindent', () => {
    expect(
      isWhitespaceOnlyHunk(hunk([line('delete', '  return 1;'), line('add', '    return 1;')])),
    ).toBe(true);
  });

  it('does not see a real edit', () => {
    expect(
      isWhitespaceOnlyHunk(hunk([line('delete', '  return 1;'), line('add', '  return 2;')])),
    ).toBe(false);
  });

  it('does not treat an added blank line as whitespace-only', () => {
    expect(isWhitespaceOnlyHunk(hunk([line('add', '')]))).toBe(false);
  });

  it('does not treat a pure deletion as whitespace-only', () => {
    expect(isWhitespaceOnlyHunk(hunk([line('delete', '  gone();')]))).toBe(false);
  });

  it('ignores context lines', () => {
    expect(
      isWhitespaceOnlyHunk(
        hunk([line('context', 'unchanged'), line('delete', 'a( b )'), line('add', 'a(b)')]),
      ),
    ).toBe(true);
  });
});

describe('isImportOnlyHunk', () => {
  it('sees es imports, requires, python, rust, c and go', () => {
    const cases = [
      "import { a } from 'a';",
      "export { b } from './b';",
      "const c = require('c');",
      'from pathlib import Path',
      'use std::fs::read_to_string;',
      '#include <stdio.h>',
      'package main',
    ];

    for (const content of cases) {
      expect(isImportOnlyHunk(hunk([line('add', content)])), content).toBe(true);
    }
  });

  it('tolerates blank lines among the imports', () => {
    expect(
      isImportOnlyHunk(hunk([line('add', "import { a } from 'a';"), line('add', '')])),
    ).toBe(true);
  });

  it('refuses when anything else changed', () => {
    expect(
      isImportOnlyHunk(hunk([line('add', "import { a } from 'a';"), line('add', 'doWork();')])),
    ).toBe(false);
  });

  it('refuses a hunk with no changed lines', () => {
    expect(isImportOnlyHunk(hunk([line('context', "import { a } from 'a';")]))).toBe(false);
  });
});

describe('isIndentationSensitive', () => {
  it('knows where whitespace is syntax', () => {
    for (const path of ['a.py', 'ci.yml', 'k8s.yaml', 'README.md', 'Makefile', 'x.hs']) {
      expect(isIndentationSensitive(path), path).toBe(true);
    }
  });

  it('leaves brace languages alone', () => {
    for (const path of ['a.ts', 'b.tsx', 'c.go', 'd.java', 'e.css']) {
      expect(isIndentationSensitive(path), path).toBe(false);
    }
  });
});

describe('classifyHunk', () => {
  it('dims a generated file whatever is in it', () => {
    const generated = file('pnpm-lock.yaml');

    expect(classifyHunk(generated, hunk([line('add', 'anything')]))).toBe('generated');
  });

  it('dims a reindent in a brace language', () => {
    expect(
      classifyHunk(file('a.ts'), hunk([line('delete', 'if(x){'), line('add', 'if (x) {')])),
    ).toBe('whitespace');
  });

  it('refuses to dim a reindent where indentation is syntax', () => {
    const reindent = hunk([line('delete', '  key: value'), line('add', '    key: value')]);

    expect(classifyHunk(file('ci.yml'), reindent)).toBeNull();
  });

  it('dims an imports-only hunk', () => {
    expect(classifyHunk(file('a.ts'), hunk([line('add', "import { a } from 'a';")]))).toBe('imports');
  });

  it('leaves real work alone', () => {
    expect(classifyHunk(file('a.ts'), hunk([line('add', 'doWork();')]))).toBeNull();
  });
});

describe('hunkIntersectsRanges', () => {
  const target = { ...hunk([]), newStart: 10, newCount: 5 }; // lines 10-14

  it('matches a range inside the hunk', () => {
    expect(hunkIntersectsRanges(target, [{ startLine: 12, endLine: 12 }])).toBe(true);
  });

  it('matches a range straddling either edge', () => {
    expect(hunkIntersectsRanges(target, [{ startLine: 5, endLine: 10 }])).toBe(true);
    expect(hunkIntersectsRanges(target, [{ startLine: 14, endLine: 30 }])).toBe(true);
  });

  it('does not match a range that misses by one', () => {
    expect(hunkIntersectsRanges(target, [{ startLine: 1, endLine: 9 }])).toBe(false);
    expect(hunkIntersectsRanges(target, [{ startLine: 15, endLine: 20 }])).toBe(false);
  });

  it('is false without ranges', () => {
    expect(hunkIntersectsRanges(target, [])).toBe(false);
    expect(hunkIntersectsRanges(target, undefined)).toBe(false);
  });
});

describe('whitespace-only judgement and reordering', () => {
  it('does not call a reordering whitespace-only', () => {
    // The same two lines come back in the other order: that is a change, not formatting.
    const reordered = hunk([
      line('delete', 'first();'),
      line('delete', 'second();'),
      line('add', 'second();'),
      line('add', 'first();'),
    ]);

    expect(isWhitespaceOnlyHunk(reordered)).toBe(false);
  });

  it('still sees a genuine reindent of several lines', () => {
    const reindented = hunk([
      line('delete', 'first();'),
      line('delete', 'second();'),
      line('add', '  first();'),
      line('add', '  second();'),
    ]);

    expect(isWhitespaceOnlyHunk(reindented)).toBe(true);
  });
})
