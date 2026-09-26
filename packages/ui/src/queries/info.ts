import { queryOptions } from '@tanstack/react-query';
import { fetchRepoInfo } from '../lib/api';

export function repoInfoOptions() {
  return queryOptions({
    queryKey: ['repo-info'],
    queryFn: () => fetchRepoInfo(),
    // Keeps the review-in-progress banner current while an agent writes.
    refetchInterval: 5000,
  });
}
