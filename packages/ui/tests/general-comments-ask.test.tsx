import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { GeneralComments } from '../src/components/comments/general-comments';
import { GENERAL_THREAD_FILE_PATH, DEFAULT_AUTHOR } from '../src/components/comments/types';
import type { CommentThread } from '../src/components/comments/types';
import type { CommentActions } from '../src/hooks/use-comment-actions';

afterEach(cleanup);

function generalThread(): CommentThread {
  return {
    id: 'g1',
    filePath: GENERAL_THREAD_FILE_PATH,
    side: 'new',
    startLine: 0,
    endLine: 0,
    status: 'open',
    comments: [{
      id: 'c0',
      author: { name: 'Agent', type: 'agent' },
      body: 'No functional issues found — 1 P3 inline.',
      createdAt: new Date().toISOString(),
    }],
  } as CommentThread;
}

function show(over: Partial<Parameters<typeof GeneralComments>[0]> = {}) {
  render(
    <GeneralComments
      threads={[generalThread()]}
      commentActions={{} as CommentActions}
      {...over}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
}

// The agent's summary lives in a general thread, so the conversation about the whole review
// happens there — it must be able to reach the agent like any anchored thread can.
describe('asking the agent from a general comment', () => {
  it('offers Ask and Act when the handlers are there', () => {
    show({ onAskReply: vi.fn(), onActReply: vi.fn() });

    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Act' })).toBeTruthy();
  });

  it('offers neither when no agent can be reached', () => {
    show();

    expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Act' })).toBeNull();
  });

  it('hands the reply to the agent with the thread it belongs to', () => {
    const onAskReply = vi.fn();
    show({ onAskReply });

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'why only one P3?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    expect(onAskReply).toHaveBeenCalledWith('g1', 'why only one P3?', DEFAULT_AUTHOR);
  });
});
