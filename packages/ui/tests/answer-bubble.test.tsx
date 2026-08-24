import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { AnswerBubble } from '../src/components/layout/answer-bubble';

afterEach(cleanup);

const one = [{ threadId: 't1', filePath: 'src/live.ts', authorName: 'Agent', preview: 'The stamp is written by the database.' }];

describe('an answer that arrived while you read on', () => {
  it('shows the reply and where it came from', () => {
    render(<AnswerBubble alerts={one} position="above" onGo={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.getByText(/The stamp is written by the database/)).toBeTruthy();
    expect(screen.getByText(/live\.ts/)).toBeTruthy();
  });

  it('sits at the top when the thread is behind you', () => {
    render(<AnswerBubble alerts={one} position="above" onGo={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.getByRole('status').className).toContain('top-');
  });

  it('sits at the bottom when the thread is ahead of you', () => {
    render(<AnswerBubble alerts={one} position="below" onGo={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.getByRole('status').className).toContain('bottom-');
  });

  it('takes you there', () => {
    const onGo = vi.fn();
    render(<AnswerBubble alerts={one} position="below" onGo={onGo} onDismiss={vi.fn()} />);

    screen.getByRole('button', { name: /the stamp is written/i }).click();

    expect(onGo).toHaveBeenCalledWith('t1');
  });

  it('can be sent away', () => {
    const onDismiss = vi.fn();
    render(<AnswerBubble alerts={one} position="below" onGo={vi.fn()} onDismiss={onDismiss} />);

    screen.getByRole('button', { name: /dismiss/i }).click();

    expect(onDismiss).toHaveBeenCalled();
  });

  // Two bubbles competing for the same corner is worse than one that counts.
  it('collapses several into one, showing the newest', () => {
    const two = [
      one[0],
      { threadId: 't2', filePath: 'src/agent.ts', authorName: 'Agent', preview: 'And the newest answer.' },
    ];
    render(<AnswerBubble alerts={two} position="above" onGo={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByText(/And the newest answer/)).toBeTruthy();
    expect(screen.getByText(/1 more/)).toBeTruthy();
  });

  it('is not there when nothing has arrived', () => {
    render(<AnswerBubble alerts={[]} position="above" onGo={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.queryByRole('status')).toBeNull();
  });
});
