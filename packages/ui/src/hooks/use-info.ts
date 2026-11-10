import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { repoInfoOptions } from '../queries/info';
import { requestReview } from '../lib/api';
import { goToSession } from '../lib/session-head';

export function useInfo() {
  const { data, error } = useSuspenseQuery(repoInfoOptions());

  return {
    data,
    error: error?.message ?? null,
  };
}

/** Hands the session to the listening agent for a review; the banner follows from the answer. */
export function useRequestReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: requestReview,
    onSuccess: ({ sessionId, ...review }) => {
      const info = queryClient.getQueryData(repoInfoOptions().queryKey);
      // The review was asked for on the pull request's current head, which is another session.
      if (sessionId && info && sessionId !== info.sessionId) {
        goToSession(sessionId);
        return;
      }
      queryClient.setQueryData(repoInfoOptions().queryKey, current => (current ? { ...current, review } : current));
    },
  });
}
