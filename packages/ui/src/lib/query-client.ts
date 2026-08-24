import { QueryClient } from '@tanstack/react-query';

/**
 * The diff and the repo info are suspense queries with no boundary of their own, so a single failed
 * fetch rebuilds the page — losing the reader's scroll position and every open panel. Restarting the
 * server is a few hundred milliseconds of failed fetches, which is not worth someone's place in a
 * diff, so a few quick retries ride it out instead.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 3,
      retryDelay: attempt => Math.min(250 * 2 ** attempt, 2000),
      refetchOnWindowFocus: false,
    },
  },
});
