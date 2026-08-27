import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react';
import { ThreadCard } from '../src/components/comments/thread-card';
import { UnheardNotice } from '../src/components/comments/unheard-notice';
import type { CommentThread } from '../src/components/comments/types';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function thread(): CommentThread {
  return {
    id: 't1',
    filePath: 'packages/cli/src/viewers.ts',
    side: 'new',
    startLine: 40,
    endLine: 40,
    status: 'open',
    comments: [{
      id: 'c0',
      author: { name: 'You', type: 'user' },
      body: 'the finding',
      createdAt: new Date().toISOString(),
    }],
  } as CommentThread;
}

function show(askIsHeard: boolean) {
  render(
    <ThreadCard
      thread={thread()}
      onEditComment={() => {}}
      onDeleteComment={() => {}}
      onDeleteThread={() => {}}
      onReply={() => {}}
      onAskReply={() => {}}
      onActReply={() => {}}
      askIsHeard={askIsHeard}
    />,
  );
}

function askSomething(text: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

describe('asking with nobody listening', () => {
  it('says so over the thread, rather than only in a tooltip', () => {
    show(false);
    askSomething('is this right?');

    const notice = screen.getByTestId('unheard-notice');
    expect(notice.textContent).toContain('No agent is connected');
    expect(notice.textContent).toContain('answered when one reconnects');
  });

  it('says nothing when an agent is waiting', () => {
    show(true);
    askSomething('is this right?');

    expect(screen.queryByTestId('unheard-notice')).toBeNull();
  });

  it('promises a change rather than an answer when Act was pressed', () => {
    show(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'rename it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Act' }));

    expect(screen.getByTestId('unheard-notice').textContent).toContain('change request');
  });

  it('can be dismissed before its time is up', () => {
    show(false);
    askSomething('is this right?');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByTestId('unheard-notice')).toBeNull();
  });
});

describe('UnheardNotice on its own', () => {
  it('goes away after five seconds without being touched', () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    render(<UnheardNotice title="No agent is connected" description="kept" onDone={onDone} />);

    expect(onDone).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(5_000));

    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
