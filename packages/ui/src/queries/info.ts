import { queryOptions } from '@tanstack/react-query';
import { fetchRepoInfo } from '../lib/api';

export function repoInfoOptions(ref?: string) {
  return queryOptions({
    queryKey: ['repo-info', ref],
    queryFn: () => fetchRepoInfo(ref),
    // A restart on a new commit creates a new session, and comments written against the id a
    // tab is still holding would land somewhere invisible.
    refetchInterval: 5000,
  });
}
