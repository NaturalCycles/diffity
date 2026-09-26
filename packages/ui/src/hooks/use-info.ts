import { useSuspenseQuery } from '@tanstack/react-query';
import { repoInfoOptions } from '../queries/info';

export function useInfo() {
  const { data, error } = useSuspenseQuery(repoInfoOptions());

  return {
    data,
    error: error?.message ?? null,
  };
}
