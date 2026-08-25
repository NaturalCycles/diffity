import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
import { AnswerBubble, SHOW_FOR_MS } from '../src/components/layout/answer-bubble';

afterEach(cleanup);

const one = [{ threadId: 't1', filePath: 'src/live.ts', authorName: 'Agent', preview: 'The stamp is written by the database.' }];

function renderBubble(position: 'above' | 'below' = 'above', onExpire = vi.fn(), onGo = vi.fn()) {
  render(<AnswerBubble alerts={one} position={position} onGo={onGo} onExpire={onExpire} onDismiss={vi.fn()} />);
  return { onExpire, onGo };
}

describe('an answer that arrived while you read on', () => {
  it('shows the reply and where it came from', () => {
    renderBubble();

    expect(screen.getByText(/The stamp is written by the database/)).toBeTruthy();
    expect(screen.getByText(/live\.ts/)).toBeTruthy();
  });

  // Over the old side, which is not the code the reader is reviewing.
  it('sits on the left, near the top when the thread is behind you', () => {
    renderBubble('above');
    const className = screen.getByRole('status').className;

    expect(className).toContain('left-');
    expect(className).toContain('top-');
  });

  it('sits low when the thread is ahead of you', () => {
    renderBubble('below');
    const className = screen.getByRole('status').className;

    expect(className).toContain('left-');
    expect(className).toContain('bottom-');
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
    render(<AnswerBubble alerts={one} position="above" onGo={vi.fn()} onExpire={onExpire} onDismiss={vi.fn()} />);

    expect(onExpire).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(SHOW_FOR_MS + 50));

    expect(onExpire).toHaveBeenCalled();
  });

  // The bar is the only thing saying it is about to leave, so it has to be running from the start.
  it('shows how much time is left', () => {
    render(<AnswerBubble alerts={one} position="above" onGo={vi.fn()} onExpire={vi.fn()} onDismiss={vi.fn()} />);

    const bar = screen.getByTestId('answer-bubble-timer');
    const atStart = bar.style.width;
    act(() => void vi.advanceTimersByTime(SHOW_FOR_MS / 2));

    expect(atStart).toBe('100%');
    expect(parseFloat(bar.style.width)).toBeLessThan(60);
  });
});
