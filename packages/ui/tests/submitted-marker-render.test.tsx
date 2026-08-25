import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { ThreadCard } from '../src/components/comments/thread-card';
import type { CommentThread } from '../src/components/comments/types';

afterEach(cleanup);

function thread(over: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 't1',
    filePath: 'src/a.ts',
    side: 'new',
    startLine: 51,
    endLine: 54,
    status: 'open',
    comments: [{
      id: 'c0',
      author: { name: 'Agent', type: 'agent' },
      body: 'Do we need .allowAdditionalProperties() here?',
      createdAt: new Date().toISOString(),
    }],
    ...over,
  } as CommentThread;
}

function show(t: CommentThread) {
  render(
    <ThreadCard thread={t} onEditComment={() => {}} onDeleteComment={() => {}} onDeleteThread={() => {}} />,
  );
}

describe('the card says whether a finding has been sent', () => {
  it('marks one that was, with the time it landed', () => {
    const at = new Date();
    at.setHours(15, 37, 0, 0);
    show(thread({ submittedAt: at.toISOString() }));

    expect(screen.getByTestId('submitted-marker').textContent).toBe('Posted to GitHub 15:37');
  });

  it('says nothing on one that was not', () => {
    show(thread());

    expect(screen.queryByTestId('submitted-marker')).toBeNull();
  });
});
