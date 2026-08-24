import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { act } from 'react';
import { CommentToolbarActions } from '../src/components/comments/comment-toolbar-actions';
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

function renderToolbar() {
  const onScrollToThread = vi.fn();
  render(
    <CommentToolbarActions
      threads={[thread('a', 'a.ts'), thread('b', 'b.ts'), thread('c', 'c.ts')]}
      onScrollToThread={onScrollToThread}
      onDeleteAllComments={vi.fn()}
      formatForCopy={() => ''}
    />,
  );
  return onScrollToThread;
}

afterEach(cleanup);

describe('CommentToolbarActions', () => {
  it('counts the comments before you have visited one', () => {
    renderToolbar();

    expect(screen.getByText('3 comments')).toBeTruthy();
  });

  it('offers no jump-to-first until you have moved past the first', () => {
    renderToolbar();

    expect(screen.queryByTitle('Back to the first comment')).toBeNull();

    act(() => screen.getByTitle('Next comment').click());
    expect(screen.queryByTitle('Back to the first comment')).toBeNull();

    act(() => screen.getByTitle('Next comment').click());
    expect(screen.getByTitle('Back to the first comment')).toBeTruthy();
  });

  it('jumps back to the first comment', () => {
    const onScrollToThread = renderToolbar();

    act(() => screen.getByTitle('Next comment').click());
    act(() => screen.getByTitle('Next comment').click());
    act(() => screen.getByTitle('Back to the first comment').click());

    expect(screen.getByText('1 of 3 comments')).toBeTruthy();
    expect(onScrollToThread).toHaveBeenLastCalledWith('a', 'a.ts');
  });
});
