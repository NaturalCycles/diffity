import { queryOptions } from '@tanstack/react-query';
import { fetchDiff } from '../lib/api';

export function diffOptions(hideWhitespace: boolean) {
  return queryOptions({
    queryKey: ['diff', hideWhitespace],
    queryFn: () => fetchDiff(hideWhitespace),
  });
}
