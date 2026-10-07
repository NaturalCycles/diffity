import { queryOptions } from '@tanstack/react-query';
import { fetchRepoInfo } from '../lib/api';
import { isReviewPending } from '../hooks/use-review-arrival';

export function repoInfoOptions() {
  return queryOptions({
    queryKey: ['repo-info'],
    queryFn: () => fetchRepoInfo(),
    // Quick while a review is arriving; otherwise slow enough to notice one that an agent starts later.
    refetchInterval: query => (isReviewPending(query.state.data?.review?.state) ? 3000 : 30_000),
  });
}
