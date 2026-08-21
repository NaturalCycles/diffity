import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { DiffHunk, DiffLine } from '@diffity/parser';
import { HunkBlock } from '../src/components/diff/hunk-block';
import { HunkBlockSplit } from '../src/components/diff/hunk-block-split';

function line(type: DiffLine['type'], content: string, num: number): DiffLine {
  return {
    type,
    content,
    oldLineNumber: type === 'add' ? null : num,
    newLineNumber: type === 'delete' ? null : num,
  };
}

const hunk: DiffHunk = {
  header: '@@ -1,2 +1,2 @@',
  oldStart: 1,
  oldCount: 2,
  newStart: 1,
  newCount: 2,
  lines: [line('context', 'const a = 1;', 1), line('add', 'const b = 2;', 2)],
};

// A tbody cannot live in a div, so the component gets a real table to render into.
function renderInTable(element: React.ReactElement) {
  const table = document.createElement('table');
  document.body.appendChild(table);
  return render(element, { container: table });
}

afterEach(cleanup);

describe.each([
  ['unified', HunkBlock],
  ['split', HunkBlockSplit],
])('%s hunk renderer', (_name, Component) => {
  it('renders without throwing when no attention is passed', () => {
    expect(() => renderInTable(<Component hunk={hunk} />)).not.toThrow();
  });

  it('puts the attention class on every row group of the hunk', () => {
    renderInTable(<Component hunk={hunk} attentionClass="opacity-45" attentionTitle="Dimmed: imports only" />);

    const bodies = Array.from(document.querySelectorAll('tbody'));
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body.className).toContain('opacity-45');
      expect(body.getAttribute('title')).toBe('Dimmed: imports only');
    }
  });

  it('leaves the row groups unmarked when the hunk needs no attention', () => {
    renderInTable(<Component hunk={hunk} />);

    for (const body of Array.from(document.querySelectorAll('tbody'))) {
      expect(body.className).not.toContain('opacity-45');
      expect(body.getAttribute('title')).toBeNull();
    }
  });
});
