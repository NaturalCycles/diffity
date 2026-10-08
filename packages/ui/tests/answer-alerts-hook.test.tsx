import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAnswerAlerts } from '../src/hooks/use-answer-alerts';
import type { Comment, CommentThread } from '../src/components/comments/types';
import { makeComment, makeThread } from './helpers/wire';

const question = (ask: Comment['ask']) =>
  makeComment({ id: 'q', author: { name: 'You', type: 'user' }, kind: 'aside', ask });
const asked = [makeThread({ comments: [question('pending')] })];
const answered = [makeThread({ comments: [question('answered')] })];

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});

afterEach(() => vi.restoreAllMocks());

function setup(onScreen: { value: boolean }) {
  const isOnScreen = () => onScreen.value;
  return renderHook(
    (props: { threads: CommentThread[] | undefined }) => useAnswerAlerts(props.threads, isOnScreen),
    { initialProps: { threads: asked } },
  );
}

async function nextFrame() {
  await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
}

describe('useAnswerAlerts', () => {
  it('raises an alert when the answered thread is off screen', () => {
    const { result, rerender } = setup({ value: false });

    rerender({ threads: answered });

    expect(result.current.alerts.map(a => a.threadId)).toEqual(['t1']);
    expect(result.current.unseenWhileHidden).toBe(0);
  });

  it('stays quiet when the thread is in view', () => {
    const { result, rerender } = setup({ value: true });

    rerender({ threads: answered });

    expect(result.current.alerts).toEqual([]);
  });

  it('does not alert for answers already there when the page loaded', () => {
    const onScreen = () => false;
    const { result } = renderHook(() => useAnswerAlerts(answered, onScreen));

    expect(result.current.alerts).toEqual([]);
  });

  it('marks the tab for an answer that lands while it is hidden, even on a thread in view', () => {
    const { result, rerender } = setup({ value: true });
    visibility = 'hidden';

    rerender({ threads: answered });

    expect(result.current.unseenWhileHidden).toBe(1);
  });

  it('counts it seen once the tab is back and the thread is on screen', async () => {
    const onScreen = { value: true };
    const { result, rerender } = setup(onScreen);
    visibility = 'hidden';
    rerender({ threads: answered });

    visibility = 'visible';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await nextFrame();

    expect(result.current.alerts).toEqual([]);
    expect(result.current.unseenWhileHidden).toBe(0);
  });

  it('keeps it while the tab is back but the thread is off screen', async () => {
    const { result, rerender } = setup({ value: false });
    visibility = 'hidden';
    rerender({ threads: answered });

    visibility = 'visible';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await nextFrame();

    expect(result.current.unseenWhileHidden).toBe(1);
  });

  it('drops the alert once the reader scrolls to the thread', async () => {
    const onScreen = { value: false };
    const { result, rerender } = setup(onScreen);
    rerender({ threads: answered });

    onScreen.value = true;
    act(() => void document.dispatchEvent(new Event('scroll')));
    await nextFrame();

    expect(result.current.alerts).toEqual([]);
  });

  it('clears one thread or all of them', () => {
    const before = [
      makeThread({ id: 'a', comments: [question('pending')] }),
      makeThread({ id: 'b', comments: [question('pending')] }),
    ];
    const after = [
      makeThread({ id: 'a', comments: [question('answered')] }),
      makeThread({ id: 'b', comments: [question('answered')] }),
    ];
    const onScreen = () => false;
    const { result, rerender } = renderHook(
      (props: { threads: CommentThread[] }) => useAnswerAlerts(props.threads, onScreen),
      { initialProps: { threads: before } },
    );
    rerender({ threads: after });

    act(() => result.current.clear('a'));
    expect(result.current.alerts.map(a => a.threadId)).toEqual(['b']);

    act(() => result.current.dismiss());
    expect(result.current.alerts).toEqual([]);
  });
});
