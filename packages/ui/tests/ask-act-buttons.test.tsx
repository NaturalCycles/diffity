import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { CommentForm } from '../src/components/comments/comment-form';

afterEach(cleanup);

describe('which of Ask and Act the reader is offered', () => {
  // Reviewing is not editing. Act being absent on somebody else's pull request is the rule, and it
  // is held up by a prop being undefined — exactly what a refactor breaks without noticing.
  it('offers neither when no agent can be reached', () => {
    render(<CommentForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Act' })).toBeNull();
  });

  it('offers Ask alone when the code is not the reader to change', () => {
    render(<CommentForm onSubmit={vi.fn()} onCancel={vi.fn()} onAsk={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Act' })).toBeNull();
  });

  it('offers both on the reader own work', () => {
    render(<CommentForm onSubmit={vi.fn()} onCancel={vi.fn()} onAsk={vi.fn()} onAct={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Act' })).toBeTruthy();
  });

  it('sends the text to whichever was pressed', () => {
    const onAsk = vi.fn();
    const onAct = vi.fn();
    render(<CommentForm onSubmit={vi.fn()} onCancel={vi.fn()} onAsk={onAsk} onAct={onAct} />);

    // React tracks the value setter, so setting .value directly never reaches onChange.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'do the thing' } });
    screen.getByRole('button', { name: 'Act' }).click();

    expect(onAct).toHaveBeenCalledWith('do the thing');
    expect(onAsk).not.toHaveBeenCalled();
  });
});
