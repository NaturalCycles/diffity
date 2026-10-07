import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { repoInfoOptions } from '../queries/info';
import { requestReview } from '../lib/api';

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
    onSuccess: review => {
      queryClient.setQueryData(repoInfoOptions().queryKey, info => (info ? { ...info, review } : info));
    },
  });
}
