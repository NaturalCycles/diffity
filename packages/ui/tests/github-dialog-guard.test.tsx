import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GitHubDialog } from '../src/components/layout/github-dialog';
import type { GitHubDetails } from '../src/lib/api';
import type { CommentThread } from '../src/components/comments/types';
import { makeComment, makeThread } from './helpers/wire';

const details: GitHubDetails = {
  prNumber: 671,
  prTitle: 'fix: keep experiment date range in sync',
  prUrl: 'https://github.com/o/r/pull/671',
  prCreatedAt: '2026-08-21T10:00:00.000Z',
  headSha: 'abc123',
  commentCount: 0,
  viewerDidAuthor: false,
  prAuthor: 'octocat',
  prBody: '',
  reviews: [],
};

function thread(id: string): CommentThread {
  return makeThread({
    id,
    comments: [makeComment({ id: `c-${id}`, body: 'P2: something' })],
  });
}

function renderDialog(reviewInProgress: boolean, threads = [thread('t1')]) {
  return render(
    <GitHubDialog
      details={details}
      threads={threads}
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
    .find(button => /^submit/i.test((button.textContent ?? '').trim()));
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

describe('approving with nothing attached', () => {
  it('is allowed once the comments are deselected', async () => {
    const user = userEvent.setup();
    renderDialog(false);

    await user.click(screen.getByRole('button', { name: /deselect all/i }));
    // A plain comment with nothing in it says nothing, so it stays refused...
    expect(submitButton().disabled).toBe(true);

    // ...but a verdict stands on its own.
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().textContent).toMatch(/approve/i);
  });

  it('is allowed with no findings at all', async () => {
    const user = userEvent.setup();
    renderDialog(false, []);

    expect(submitButton().disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(submitButton().disabled).toBe(false);
  });
});
