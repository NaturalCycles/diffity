import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommentForm } from '../src/components/comments/comment-form';
import { ThreadCard } from '../src/components/comments/thread-card';
import { AgentListeningContext } from '../src/lib/agent-listening';
import { makeComment, makeThread } from './helpers/wire';

afterEach(cleanup);

function form(listening: boolean, onAsk?: (body: string) => void, onSubmit = vi.fn()) {
  render(
    <AgentListeningContext.Provider value={listening}>
      <CommentForm onSubmit={onSubmit} onCancel={() => {}} onAsk={onAsk} />
    </AgentListeningContext.Provider>,
  );
  return onSubmit;
}

describe('Ask Claude on the comment box', () => {
  it('hands the text to the agent while one is listening', async () => {
    const user = userEvent.setup({ delay: null });
    const onAsk = vi.fn();
    const onSubmit = form(true, onAsk);

    const ask = screen.getByRole('button', { name: 'Ask Claude' });
    expect(ask).toHaveProperty('disabled', true);
    await user.type(screen.getByPlaceholderText('Leave a comment'), 'why this?');
    expect(ask).toHaveProperty('disabled', false);
    await user.click(ask);

    expect(onAsk).toHaveBeenCalledWith('why this?');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('is there but disabled, saying why, while no agent is listening', async () => {
    const user = userEvent.setup({ delay: null });
    form(false, vi.fn());

    await user.type(screen.getByPlaceholderText('Leave a comment'), 'why this?');
    const ask = screen.getByRole('button', { name: 'Ask Claude' });
    expect(ask).toHaveProperty('disabled', true);
    expect(ask.parentElement?.getAttribute('title')).toBe('No agent is listening on this review');
  });

  it('is not offered where nothing can be asked', () => {
    form(true);
    expect(screen.queryByRole('button', { name: 'Ask Claude' })).toBeNull();
  });

  it('asks from a reply', async () => {
    const user = userEvent.setup({ delay: null });
    const onAskReply = vi.fn();
    render(
      <AgentListeningContext.Provider value={true}>
        <ThreadCard
          thread={makeThread({ comments: [makeComment({ body: 'P2: x' })] })}
          onReply={vi.fn()}
          onAskReply={onAskReply}
          onEditComment={() => {}}
          onDeleteComment={() => {}}
          onDeleteThread={() => {}}
        />
      </AgentListeningContext.Provider>,
    );

    await user.click(screen.getByText('Reply'));
    await user.type(screen.getByPlaceholderText('Reply...'), 'really?');
    await user.click(screen.getByRole('button', { name: 'Ask Claude' }));

    expect(onAskReply).toHaveBeenCalledWith('really?');
  });
});

describe('a question’s badge', () => {
  it.each([
    ['pending', 'asked'],
    ['answered', 'answered'],
  ] as const)('shows a %s question as "%s"', (ask, label) => {
    render(
      <ThreadCard
        thread={makeThread({ comments: [makeComment({ id: 'q', body: 'why?', kind: 'aside', ask, author: { name: 'You', type: 'user' } })] })}
        onEditComment={() => {}}
        onDeleteComment={() => {}}
        onDeleteThread={() => {}}
      />,
    );
    expect(screen.getByText(label)).toBeTruthy();
  });
});
