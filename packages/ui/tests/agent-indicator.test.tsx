import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { Toolbar } from '../src/components/layout/toolbar';

afterEach(cleanup);

function show(agentListening: boolean, agentWorking: number) {
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
      repoName="widgets"
      branch="main"
      description={null}
      githubDetails={null}
      agentListening={agentListening}
      agentWorking={agentWorking}
    />,
  );
}

describe('the agent indicator', () => {
  it('says the agent is working, with a pulse, while it holds a request', () => {
    show(true, 2);
    const working = screen.getByText('Agent working');
    expect(working.querySelector('.animate-pulse')).toBeTruthy();
    expect(working.getAttribute('title')).toBe('The agent is working on 2 requests.');
    expect(screen.queryByText('Agent listening')).toBeNull();
  });

  it('says it is listening while it waits, and nothing without an agent', () => {
    show(true, 0);
    expect(screen.getByText('Agent listening')).toBeTruthy();
    expect(screen.queryByText('Agent working')).toBeNull();
    cleanup();
    show(false, 0);
    expect(screen.queryByText('Agent listening')).toBeNull();
    expect(screen.queryByText('Agent working')).toBeNull();
  });
});
