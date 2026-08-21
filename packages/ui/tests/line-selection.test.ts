import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLineSelection } from '../src/hooks/use-line-selection';
import type { LineSelection } from '../src/components/comments/types';

function setup(pendingSelection: LineSelection | null = null) {
  const onSelectionComplete = vi.fn();
  const hook = renderHook(() =>
    useLineSelection({ filePath: 'src/a.ts', onSelectionComplete, pendingSelection }),
  );
  return { hook, onSelectionComplete };
}

describe('shift-clicking a second line', () => {
  it('extends the pending comment to a span', () => {
    const pending: LineSelection = { filePath: 'src/a.ts', side: 'new', startLine: 3, endLine: 3 };
    const { hook, onSelectionComplete } = setup(pending);

    act(() => hook.result.current.handleLineMouseDown(6, 'new', true));

    expect(onSelectionComplete).toHaveBeenCalledWith({
      filePath: 'src/a.ts',
      side: 'new',
      startLine: 3,
      endLine: 6,
    });
  });

  it('extends upwards just as well', () => {
    const pending: LineSelection = { filePath: 'src/a.ts', side: 'new', startLine: 20, endLine: 20 };
    const { hook, onSelectionComplete } = setup(pending);

    act(() => hook.result.current.handleLineMouseDown(14, 'new', true));

    expect(onSelectionComplete).toHaveBeenCalledWith(
      expect.objectContaining({ startLine: 14, endLine: 20 }),
    );
  });

  it('grows an existing span rather than collapsing it', () => {
    const pending: LineSelection = { filePath: 'src/a.ts', side: 'new', startLine: 10, endLine: 12 };
    const { hook, onSelectionComplete } = setup(pending);

    act(() => hook.result.current.handleLineMouseDown(15, 'new', true));

    expect(onSelectionComplete).toHaveBeenCalledWith(
      expect.objectContaining({ startLine: 10, endLine: 15 }),
    );
  });

  it('will not span the two sides of the diff', () => {
    const pending: LineSelection = { filePath: 'src/a.ts', side: 'old', startLine: 3, endLine: 3 };
    const { hook, onSelectionComplete } = setup(pending);

    act(() => hook.result.current.handleLineMouseDown(6, 'new', true));

    expect(onSelectionComplete).not.toHaveBeenCalled();
  });

  it('starts fresh when there is nothing to extend', () => {
    const { hook, onSelectionComplete } = setup(null);

    act(() => hook.result.current.handleLineMouseDown(6, 'new', true));

    expect(onSelectionComplete).not.toHaveBeenCalled();
    expect(hook.result.current.isLineInSelection(6, 'new')).toBe(true);
  });

  it('leaves a plain click alone', () => {
    const pending: LineSelection = { filePath: 'src/a.ts', side: 'new', startLine: 3, endLine: 3 };
    const { hook, onSelectionComplete } = setup(pending);

    act(() => hook.result.current.handleLineMouseDown(6, 'new', false));

    expect(onSelectionComplete).not.toHaveBeenCalled();
    expect(hook.result.current.isLineInSelection(6, 'new')).toBe(true);
    expect(hook.result.current.isLineInSelection(3, 'new')).toBe(false);
  });
});
