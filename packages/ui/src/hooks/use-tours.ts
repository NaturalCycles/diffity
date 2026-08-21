import { useQuery } from '@tanstack/react-query';
import { fetchTours, type Tour } from '../lib/api';

export function useTours(sessionId: string | null | undefined) {
  return useQuery<Tour[]>({
    queryKey: ['tours', sessionId],
    queryFn: () => fetchTours(sessionId!),
    enabled: !!sessionId,
    // Matches the comment poll, so a walkthrough appears step by step while it is written.
    refetchInterval: 2000,
  });
}
