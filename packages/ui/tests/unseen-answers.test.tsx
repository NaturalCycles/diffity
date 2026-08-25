import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { UnseenAnswers } from '../src/components/layout/unseen-answers';

afterEach(cleanup);

const two = [
  { threadId: 't1', filePath: 'a.ts', authorName: 'Agent', preview: 'first' },
  { threadId: 't2', filePath: 'b.ts', authorName: 'Agent', preview: 'second' },
];

describe('what is left after a note has gone', () => {
  it('is nothing at all when nothing is unseen', () => {
    render(<UnseenAnswers alerts={[]} onGo={vi.fn()} />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('counts what is waiting', () => {
    render(<UnseenAnswers alerts={two} onGo={vi.fn()} />);

    expect(screen.getByText('2')).toBeTruthy();
  });

  // The oldest, so following it repeatedly walks the reader through them in the order they arrived.
  it('goes to the one that has been waiting longest', () => {
    const onGo = vi.fn();
    render(<UnseenAnswers alerts={two} onGo={onGo} />);

    screen.getByRole('button').click();

    expect(onGo).toHaveBeenCalledWith('t1');
  });

  it('says what it will do', () => {
    render(<UnseenAnswers alerts={two} onGo={vi.fn()} />);

    expect(screen.getByRole('button').getAttribute('title')).toMatch(/2 answers/i);
  });

  it('counts one in the singular', () => {
    render(<UnseenAnswers alerts={[two[0]]} onGo={vi.fn()} />);

    expect(screen.getByRole('button').getAttribute('title')).toMatch(/1 answer\b/i);
  });
});
