import { describe, it, expect } from 'vitest';
import { queryClient } from '../src/lib/query-client';

describe('the query client', () => {
  // The diff and the repo info are suspense queries with no boundary of their own, so one failed
  // fetch rebuilds the whole page: scroll position, open panels and all. A server restart is a
  // few hundred milliseconds of failed fetches, and it should not cost the reader their place.
  it('rides out a blip rather than rebuilding the page', () => {
    const { retry, retryDelay } = queryClient.getDefaultOptions().queries ?? {};

    expect(retry).not.toBe(false);
    expect(retry).toBeGreaterThanOrEqual(2);
    expect(retryDelay).toBeDefined();
  });

  it('still does not refetch everything when the window regains focus', () => {
    expect(queryClient.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
  });
});
