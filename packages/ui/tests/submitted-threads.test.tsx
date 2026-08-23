import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { GitHubDialog } from '../src/components/layout/github-dialog';
import type { GitHubDetails } from '../src/lib/api';
import type { CommentThread } from '../src/components/comments/types';
import { isSubmittable, threadToPayload } from '../src/lib/review-submission';

const details: GitHubDetails = {
  prNumber: 14378,
  prTitle: 'feat: Apple Watch raw data mapping A2',
  prUrl: 'https://github.com/o/r/pull/14378',
  prCreatedAt: '2026-08-21T10:00:00.000Z',
  headSha: 'abc123',
  commentCount: 2,
  viewerDidAuthor: false,
  prBody: '',
  reviews: [],
};

function thread(id: string, body: string, submittedAt: string | null = null): CommentThread {
  return {
    id,
    filePath: 'src/a.ts',
    side: 'new',
    startLine: 10,
    endLine: 10,
    status: 'open',
    submittedAt,
    comments: [{ id: `c-${id}`, author: { name: 'Agent', type: 'agent' }, body, createdAt: '' }],
  };
}

function renderDialog(threads: CommentThread[]) {
  return render(
    <GitHubDialog
      details={details}
      threads={threads}
      sessionId="s1"
      onPulled={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

function submitButton(): HTMLButtonElement {
  return screen
    .getAllByRole('button')
    .find(b => /^submit/i.test((b.textContent ?? '').trim())) as HTMLButtonElement;
}

afterEach(cleanup);

describe('a finding already sent to the forge', () => {
  it('says so, rather than looking identical to an unsent one', () => {
    renderDialog([thread('t1', 'P2: already sent', '2026-08-21 16:01:10')]);

    expect(screen.getByText(/already on the pull request/i)).toBeTruthy();
  });

  it('is not selected, so submitting again is a deliberate act', () => {
    renderDialog([thread('t1', 'P2: already sent', '2026-08-21 16:01:10')]);

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.every(box => !box.checked)).toBe(true);
    // Nothing selected and no summary, so a plain comment review has nothing to say.
    expect(submitButton().disabled).toBe(true);
  });

  it('leaves an unsent finding selected', () => {
    renderDialog([thread('t1', 'P2: not sent', null)]);

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.some(box => box.checked)).toBe(true);
    expect(submitButton().disabled).toBe(false);
  });
});

describe('the payload', () => {
  it('carries the finding id, so the forge reply can mark it', () => {
    expect(threadToPayload(thread('t9', 'P1: x')).threadId).toBe('t9');
  });

  it('still offers an already-sent finding, in case it must go again', () => {
    // Excluded from the default selection, not from the list: a reviewer may resend deliberately.
    expect(isSubmittable(thread('t1', 'x', '2026-08-21 16:01:10'))).toBe(true);
  });
});
