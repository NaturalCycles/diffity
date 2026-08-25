import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
import { AnswerBubble, SHOW_FOR_MS } from '../src/components/layout/answer-bubble';

afterEach(cleanup);

const one = [{ threadId: 't1', filePath: 'src/live.ts', authorName: 'Agent', preview: 'The stamp is written by the database.' }];

function renderBubble(position: 'above' | 'below' = 'above', onExpire = vi.fn(), onGo = vi.fn()) {
  render(<AnswerBubble alerts={one} position={position} viewMode="split" onGo={onGo} onExpire={onExpire} onDismiss={vi.fn()} />);
  return { onExpire, onGo };
}

describe('an answer that arrived while you read on', () => {
  it('shows the reply and where it came from', () => {
    renderBubble();

    expect(screen.getByText(/The stamp is written by the database/)).toBeTruthy();
    expect(screen.getByText(/live\.ts/)).toBeTruthy();
  });

  // Over the old side, which is not the code the reader is reviewing.
  // Right-aligned against the middle gutter, so it covers the right of the old side and never the
  // new code being reviewed.
  it('stops just short of the middle gutter in split view', () => {
    renderBubble('above');
    const className = screen.getByRole('status').className;

    expect(className).toContain('left-1/2');
    expect(className).toContain('-translate-x-full');
    expect(className).toContain('top-');
  });

  it('sits low when the thread is ahead of you', () => {
    renderBubble('below');

    expect(screen.getByRole('status').className).toContain('bottom-');
  });

  it('keeps to the left in unified view, where there is no midpoint', () => {
    render(<AnswerBubble alerts={one} position="above" viewMode="unified" onGo={vi.fn()} onExpire={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.getByRole('status').className).toContain('left-4');
  });

  it('takes you there', () => {
    const { onGo } = renderBubble();

    screen.getByRole('button', { name: /the stamp is written/i }).click();

    expect(onGo).toHaveBeenCalledWith('t1');
  });

  it('collapses several into one, showing the newest', () => {
    render(
      <AnswerBubble
        alerts={[one[0], { threadId: 't2', filePath: 'src/agent.ts', authorName: 'Agent', preview: 'And the newest answer.' }]}
        position="above"
        viewMode="split"
        onGo={vi.fn()}
        onExpire={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByText(/And the newest answer/)).toBeTruthy();
    expect(screen.getByText(/1 more/)).toBeTruthy();
  });
});

describe('how long it stays', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('goes on its own rather than sitting there', () => {
    const onExpire = vi.fn();
    render(<AnswerBubble alerts={one} position="above" viewMode="split" onGo={vi.fn()} onExpire={onExpire} onDismiss={vi.fn()} />);

    expect(onExpire).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(SHOW_FOR_MS + 50));

    expect(onExpire).toHaveBeenCalled();
  });

  // The bar is the only thing saying it is about to leave, so it has to be running from the start.
  it('shows how much time is left', () => {
    render(<AnswerBubble alerts={one} position="above" viewMode="split" onGo={vi.fn()} onExpire={vi.fn()} onDismiss={vi.fn()} />);

    const bar = screen.getByTestId('answer-bubble-timer');
    const atStart = bar.style.width;
    act(() => void vi.advanceTimersByTime(SHOW_FOR_MS / 2));

    expect(atStart).toBe('100%');
    expect(parseFloat(bar.style.width)).toBeLessThan(60);
  });
});
