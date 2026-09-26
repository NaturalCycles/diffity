import { useSuspenseQuery } from '@tanstack/react-query';
import { diffOptions } from '../queries/diff';

export function useDiff(hideWhitespace = false) {
  const { data, error } = useSuspenseQuery(diffOptions(hideWhitespace));

  return {
    data,
    error: error?.message ?? null,
  };
}
