import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { AnswerBubble } from '../src/components/layout/answer-bubble';
import type { AnswerAlert } from '../src/lib/answer-alerts';

afterEach(cleanup);

const onFile: AnswerAlert = { threadId: 't1', filePath: 'src/live.ts', startLine: 12, whileHidden: false };
const general: AnswerAlert = { threadId: 't2', filePath: '__general__', startLine: 0, whileHidden: false };

describe('AnswerBubble', () => {
  it('says where the answer is', () => {
    render(<AnswerBubble alerts={[onFile]} onGo={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.getByRole('status').textContent).toContain('Agent answered · live.ts:12');
  });

  it('lists several in one bubble', () => {
    render(<AnswerBubble alerts={[onFile, general]} onGo={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /live\.ts:12/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /General/ })).toBeTruthy();
  });

  it('takes you to the thread that was clicked', () => {
    const onGo = vi.fn();
    render(<AnswerBubble alerts={[onFile, general]} onGo={onGo} onDismiss={vi.fn()} />);

    screen.getByRole('button', { name: /General/ }).click();

    expect(onGo).toHaveBeenCalledWith(general);
  });

  it('can be dismissed', () => {
    const onDismiss = vi.fn();
    render(<AnswerBubble alerts={[onFile]} onGo={vi.fn()} onDismiss={onDismiss} />);

    screen.getByRole('button', { name: 'Dismiss' }).click();

    expect(onDismiss).toHaveBeenCalled();
  });

  it('renders nothing with nothing to say', () => {
    render(<AnswerBubble alerts={[]} onGo={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.queryByRole('status')).toBeNull();
  });
});
