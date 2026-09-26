import { queryOptions } from '@tanstack/react-query';
import { fetchRepoInfo } from '../lib/api';

export function repoInfoOptions() {
  return queryOptions({
    queryKey: ['repo-info'],
    queryFn: () => fetchRepoInfo(),
    // A restart on a new commit creates a new session, and comments written against the id a
    // tab is still holding would land somewhere invisible.
    refetchInterval: 5000,
  });
}
