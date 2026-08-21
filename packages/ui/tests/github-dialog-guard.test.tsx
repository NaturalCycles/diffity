import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { GitHubDialog } from '../src/components/layout/github-dialog';
import type { GitHubDetails } from '../src/lib/api';
import type { CommentThread } from '../src/components/comments/types';

const details: GitHubDetails = {
  prNumber: 671,
  prTitle: 'fix: keep experiment date range in sync',
  prUrl: 'https://github.com/o/r/pull/671',
  prCreatedAt: '2026-08-21T10:00:00.000Z',
  headSha: 'abc123',
  commentCount: 0,
  viewerDidAuthor: false,
};

function thread(id: string): CommentThread {
  return {
    id,
    filePath: 'src/a.ts',
    side: 'new',
    startLine: 10,
    endLine: 10,
    status: 'open',
    comments: [
      { id: `c-${id}`, author: { name: 'Agent', type: 'agent' }, body: 'P2: something', createdAt: '' },
    ],
  };
}

function renderDialog(reviewInProgress: boolean) {
  return render(
    <GitHubDialog
      details={details}
      threads={[thread('t1')]}
      sessionId="s1"
      reviewInProgress={reviewInProgress}
      onPulled={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

function submitButton(): HTMLButtonElement {
  const found = screen
    .getAllByRole('button')
    .find(button => /as one review/i.test(button.textContent ?? ''));
  if (!found) {
    throw new Error('submit button not found');
  }
  return found as HTMLButtonElement;
}

afterEach(cleanup);

describe('submitting while a review is still running', () => {
  it('is refused, with the reason visible', () => {
    renderDialog(true);

    expect(submitButton().disabled).toBe(true);
    expect(screen.getByText(/still in progress/i)).toBeTruthy();
  });

  it('is allowed once the review has finished', () => {
    renderDialog(false);

    expect(submitButton().disabled).toBe(false);
    expect(screen.queryByText(/still in progress/i)).toBeNull();
  });
});
