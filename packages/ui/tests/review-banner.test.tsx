import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReviewRun, ReviewState } from '@diffity/api';
import { ReviewBanner } from '../src/components/layout/review-banner';
import { ARRIVAL_QUERY_KEYS, useHeld, useReviewArrival } from '../src/hooks/use-review-arrival';
import { repoInfoOptions } from '../src/queries/info';
import { useRequestReview } from '../src/hooks/use-info';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  it('says the agent picked it up before it starts', () => {
    banner(run('claimed', { queuedAt: new Date().toISOString() }));
    const shown = screen.getByTestId('review-banner');
    expect(shown.dataset.state).toBe('claimed');
    expect(shown.textContent).toContain('Your agent picked this up…');
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

  it('offers a review to a listening agent when none is under way, and again on a stale one', () => {
    const onRequestReview = vi.fn();
    const offered = (review: ReviewRun, agentListening: boolean) => render(
      <ReviewBanner review={review} findings={0} ready={false} onReload={() => {}} agentListening={agentListening} onRequestReview={onRequestReview} />,
    );

    for (const state of ['none', 'done'] as const) {
      offered(run(state), true);
      fireEvent.click(screen.getByRole('button', { name: 'Ask your agent to review' }));
      cleanup();
      offered(run(state), false);
      expect(screen.queryByTestId('review-banner')).toBeNull();
      cleanup();
    }
    offered(run('stale'), true);
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    cleanup();
    offered(run('stale'), false);
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
    cleanup();
    for (const state of ['queued', 'claimed', 'reviewing'] as const) {
      offered(run(state), true);
      expect(screen.queryByRole('button')).toBeNull();
      cleanup();
    }
    expect(onRequestReview).toHaveBeenCalledTimes(3);
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

function RequestHarness() {
  const { data } = useQuery(repoInfoOptions());
  const request = useRequestReview();
  return data?.review
    ? <ReviewBanner review={data.review} findings={0} ready={false} onReload={() => {}} agentListening onRequestReview={() => request.mutate()} />
    : null;
}

describe('asking for a review from the page', () => {
  it('posts the request and shows the review queued', async () => {
    const posted: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/review-request')) {
        posted.push(init?.method ?? 'GET');
        return Response.json(run('queued', { queuedAt: new Date().toISOString() }));
      }
      return Response.json({ sessionId: 's', review: run('done') });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RequestHarness />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Ask your agent to review' }));
    await waitFor(() => expect(screen.getByTestId('review-banner').dataset.state).toBe('queued'));
    expect(posted).toEqual(['POST']);
    client.clear();
  });
});

describe('the info poll', () => {
  it('runs every 3 s while a review is queued, taken or under way, and every 30 s otherwise', () => {
    const interval = repoInfoOptions().refetchInterval as (query: { state: { data: unknown } }) => number;
    const pollFor = (state: ReviewState) => interval({ state: { data: { review: run(state) } } });
    expect(pollFor('queued')).toBe(3000);
    expect(pollFor('claimed')).toBe(3000);
    expect(pollFor('reviewing')).toBe(3000);
    expect(pollFor('done')).toBe(30_000);
    expect(pollFor('stale')).toBe(30_000);
    expect(pollFor('none')).toBe(30_000);
    expect(interval({ state: { data: undefined } })).toBe(30_000);
  });
});
