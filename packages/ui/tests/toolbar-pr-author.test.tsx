import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { Toolbar } from '../src/components/layout/toolbar';
import type { GitHubDetails } from '../src/lib/api';

afterEach(cleanup);

const details: GitHubDetails = {
  prNumber: 14390,
  prTitle: 'fix: no longer pregnant fix for never pregnant user',
  prAuthor: 'nc-felicia',
  prUrl: 'https://github.com/NaturalCycles/NCBackend3/pull/14390',
  prCreatedAt: '2026-08-25T08:00:00Z',
  headSha: 'abc123',
  commentCount: 0,
  viewerDidAuthor: false,
  prBody: '',
  reviews: [],
};

function show(githubDetails: GitHubDetails | null) {
  render(
    <Toolbar
      viewMode="split"
      onViewModeChange={() => {}}
      hideWhitespace={false}
      onHideWhitespaceChange={() => {}}
      theme="dark"
      onToggleTheme={() => {}}
      wrapLines={false}
      onToggleWrapLines={() => {}}
      onShowHelp={() => {}}
      threads={[]}
      onDeleteAllComments={() => {}}
      onScrollToThread={() => {}}
      repoName="NCBackend3"
      branch="DEV-13465-no-longer-preg"
      description="Changes from master"
      githubDetails={githubDetails}
    />,
  );
}

describe('the toolbar says whose pull request this is', () => {
  it('names the author beside the number', () => {
    show(details);

    expect(screen.getByText('#14390')).toBeTruthy();
    expect(screen.getByText('by nc-felicia')).toBeTruthy();
  });

  // An author is not always known — a detached session, or gh returning nothing useful.
  it('shows the number alone when it is not', () => {
    show({ ...details, prAuthor: '' });

    expect(screen.getByText('#14390')).toBeTruthy();
    expect(screen.queryByText(/^by /)).toBeNull();
  });
});
