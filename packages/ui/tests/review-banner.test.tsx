import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReviewRun, ReviewState } from '@diffity/api';
import { ReviewBanner } from '../src/components/layout/review-banner';
import { ARRIVAL_QUERY_KEYS, useHeld, useReviewArrival } from '../src/hooks/use-review-arrival';
import { repoInfoOptions } from '../src/queries/info';

afterEach(cleanup);

function run(state: ReviewState, fields: Partial<ReviewRun> = {}): ReviewRun {
  return { state, queuedAt: null, startedAt: null, doneAt: null, note: '', ...fields };
}

function banner(review: ReviewRun, ready = false, findings = 0) {
  return render(<ReviewBanner review={review} findings={findings} ready={ready} onReload={() => {}} />);
}

describe('the review banner', () => {
  it('says a queued review waits for the agent', () => {
    banner(run('queued', { queuedAt: new Date().toISOString() }));
    expect(screen.getByTestId('review-banner').textContent).toContain('Queued for your agent');
  });

  it('counts the findings while the agent reviews', () => {
    banner(run('reviewing', { note: 'first pass' }), false, 3);
    const text = screen.getByTestId('review-banner').textContent;
    expect(text).toContain('Reviewing…');
    expect(text).toContain('3 findings so far');
    expect(text).toContain('first pass');
  });

  it('says nobody picked a stale one up, and how to get an agent', () => {
    banner(run('stale'));
    const text = screen.getByTestId('review-banner').textContent;
    expect(text).toContain('No agent picked this up');
    expect(text).toContain('review prompt');
  });

  it('offers the reload only for a review that finished while the page was open', () => {
    banner(run('done'), true);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    cleanup();
    banner(run('done'), false);
    expect(screen.queryByTestId('review-banner')).toBeNull();
    cleanup();
    banner(run('none'));
    expect(screen.queryByTestId('review-banner')).toBeNull();
  });
});

function Harness(props: { review: ReviewRun; order: string }) {
  const arrival = useReviewArrival(props.review.state);
  const order = useHeld(props.order, arrival.watching);
  return (
    <>
      <ReviewBanner review={props.review} findings={1} ready={arrival.ready} onReload={arrival.reload} />
      <span data-testid="order">{order}</span>
    </>
  );
}

describe('a review arriving on an open page', () => {
  it('keeps the reading order until the reader reloads, which refetches what the review changed', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    const page = (review: ReviewRun, order: string) => (
      <QueryClientProvider client={client}>
        <Harness review={review} order={order} />
      </QueryClientProvider>
    );

    const { rerender } = render(page(run('queued'), 'diff order'));
    expect(screen.getByTestId('review-banner').dataset.state).toBe('queued');
    rerender(page(run('reviewing'), 'reading order'));
    expect(screen.getByTestId('review-banner').dataset.state).toBe('reviewing');
    rerender(page(run('done'), 'reading order'));
    expect(screen.getByTestId('order').textContent).toBe('diff order');

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(ARRIVAL_QUERY_KEYS);
    expect(screen.queryByTestId('review-banner')).toBeNull();
    expect(screen.getByTestId('order').textContent).toBe('reading order');
  });

  it('leaves a page opened on a finished review alone', () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <Harness review={run('done')} order="reading order" />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId('review-banner')).toBeNull();
    expect(screen.getByTestId('order').textContent).toBe('reading order');
  });
});

describe('the info poll', () => {
  it('runs every 3 s while a review is queued or under way, and every 30 s otherwise', () => {
    const interval = repoInfoOptions().refetchInterval as (query: { state: { data: unknown } }) => number;
    const pollFor = (state: ReviewState) => interval({ state: { data: { review: run(state) } } });
    expect(pollFor('queued')).toBe(3000);
    expect(pollFor('reviewing')).toBe(3000);
    expect(pollFor('done')).toBe(30_000);
    expect(pollFor('stale')).toBe(30_000);
    expect(pollFor('none')).toBe(30_000);
    expect(interval({ state: { data: undefined } })).toBe(30_000);
  });
});
