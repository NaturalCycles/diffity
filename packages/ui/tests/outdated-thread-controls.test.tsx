import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrphanedThreads } from '../src/components/comments/orphaned-threads';
import type { CommentActions } from '../src/hooks/use-comment-actions';
import { DEFAULT_AUTHOR } from '../src/components/comments/types';
import type { CommentThread } from '../src/components/comments/types';
import { makeComment, makeThread } from './helpers/wire';

function actions(): CommentActions {
  return {
    addThread: vi.fn(),
    addReply: vi.fn(),
    resolveThread: vi.fn(),
    unresolveThread: vi.fn(),
    dismissThread: vi.fn(),
    editComment: vi.fn(),
    deleteComment: vi.fn(),
    deleteThread: vi.fn(),
    deleteAllThreads: vi.fn(),
  };
}

function outdated(over: Partial<CommentThread> = {}): CommentThread {
  return makeThread({
    id: 'gone',
    anchorContent: 'const removed = true;',
    comments: [makeComment({ id: 'c1', body: 'P2: this reads oddly' })],
    ...over,
  });
}

function renderThreads(commentActions: CommentActions, thread = outdated()) {
  return render(<OrphanedThreads threads={[thread]} commentActions={commentActions} />);
}

afterEach(cleanup);

describe('an outdated thread', () => {
  it('can be replied to', async () => {
    // Per-keystroke delays are the default and make this the slowest test in the file.
    const user = userEvent.setup({ delay: null });
    const commentActions = actions();
    renderThreads(commentActions);

    await user.click(screen.getByText('Reply'));
    await user.type(screen.getByPlaceholderText('Reply...'), 'still applies');
    await user.click(screen.getByRole('button', { name: 'Reply' }));

    expect(commentActions.addReply).toHaveBeenCalledWith('gone', 'still applies', DEFAULT_AUTHOR);
  });

  it('can be resolved', async () => {
    const user = userEvent.setup({ delay: null });
    const commentActions = actions();
    renderThreads(commentActions);

    await user.click(screen.getByText('Resolve'));

    expect(commentActions.resolveThread).toHaveBeenCalledWith('gone');
  });

  it('offers reopen once resolved, not resolve again', async () => {
    const user = userEvent.setup({ delay: null });
    const commentActions = actions();
    renderThreads(commentActions, outdated({ status: 'resolved' }));
    // Nothing here is open, so the list starts collapsed.
    await user.click(screen.getByText('1 outdated comment'));

    expect(screen.queryByText('Resolve')).toBeNull();
    await user.click(screen.getByText('Reopen'));

    expect(commentActions.unresolveThread).toHaveBeenCalledWith('gone');
  });

  it('keeps the stale anchor on show', () => {
    renderThreads(actions());

    expect(screen.getByText('const removed = true;')).toBeTruthy();
  });
});
