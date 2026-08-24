import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useThreadNavigation } from '../src/hooks/use-thread-navigation';
import type { CommentThread } from '../src/components/comments/types';

function thread(id: string, filePath: string): CommentThread {
  return {
    id,
    sessionId: 'sess',
    filePath,
    side: 'new',
    startLine: 1,
    endLine: 1,
    status: 'open',
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-24T10:00:00.000Z',
    comments: [],
  } as unknown as CommentThread;
}

const threads = [thread('a', 'a.ts'), thread('b', 'b.ts'), thread('c', 'c.ts')];

describe('useThreadNavigation', () => {
  it('starts with no comment current, so the first press goes to the first comment', () => {
    const onScroll = vi.fn();
    const { result } = renderHook(() => useThreadNavigation(threads, onScroll));

    expect(result.current.currentIndex).toBe(-1);

    act(() => result.current.goToNext());

    expect(result.current.currentIndex).toBe(0);
    expect(onScroll).toHaveBeenCalledWith('a', 'a.ts');
  });

  it('jumps back to the first comment from anywhere', () => {
    const onScroll = vi.fn();
    const { result } = renderHook(() => useThreadNavigation(threads, onScroll));

    act(() => result.current.goToNext());
    act(() => result.current.goToNext());
    expect(result.current.currentIndex).toBe(1);

    act(() => result.current.goToFirst());

    expect(result.current.currentIndex).toBe(0);
    expect(onScroll).toHaveBeenLastCalledWith('a', 'a.ts');
  });

  it('does nothing on an empty list', () => {
    const onScroll = vi.fn();
    const { result } = renderHook(() => useThreadNavigation([], onScroll));

    act(() => result.current.goToFirst());

    expect(result.current.currentIndex).toBe(-1);
    expect(onScroll).not.toHaveBeenCalled();
  });
});
