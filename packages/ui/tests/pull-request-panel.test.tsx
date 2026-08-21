import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { PullRequestPanel } from '../src/components/layout/pull-request-panel';
import type { GitHubDetails } from '../src/lib/api';

function details(overrides: Partial<GitHubDetails> = {}): GitHubDetails {
  return {
    prNumber: 671,
    prTitle: 'fix: keep experiment date range in sync',
    prUrl: 'https://github.com/o/r/pull/671',
    prCreatedAt: '2026-08-21T10:00:00.000Z',
    headSha: 'abc123',
    commentCount: 0,
    viewerDidAuthor: false,
    prBody: '## Summary\n\nThe field went stale until a refresh.',
    reviews: [],
    ...overrides,
  };
}

afterEach(cleanup);

describe('PullRequestPanel', () => {
  it('shows the description, which is where the author says what the change is for', () => {
    render(<PullRequestPanel details={details()} />);

    expect(screen.getByText(/went stale until a refresh/i)).toBeTruthy();
  });

  it('shows what other reviewers already said', () => {
    render(
      <PullRequestPanel
        details={details({
          reviews: [
            { author: 'copilot[bot]', isBot: true, state: 'COMMENTED', body: 'Overview of the change', submittedAt: '2026-08-21T11:54:36Z' },
            { author: 'fiddur', isBot: false, state: 'APPROVED', body: 'lgtm', submittedAt: '2026-08-21T12:11:34Z' },
          ],
        })}
      />,
    );

    expect(screen.getByText('copilot[bot]')).toBeTruthy();
    expect(screen.getByText(/Overview of the change/)).toBeTruthy();
    expect(screen.getByText('fiddur')).toBeTruthy();
    expect(screen.getByText('APPROVED')).toBeTruthy();
  });

  it('says so plainly when there is no description', () => {
    render(<PullRequestPanel details={details({ prBody: '' })} />);

    expect(screen.getByText(/no description/i)).toBeTruthy();
  });

  it('renders nothing at all without a pull request', () => {
    const { container } = render(<PullRequestPanel details={null} />);

    expect(container.textContent).toBe('');
  });
});
