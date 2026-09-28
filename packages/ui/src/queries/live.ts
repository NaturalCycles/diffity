import { queryOptions } from '@tanstack/react-query';
import { fetchLiveStatus } from '../lib/api';

export function liveStatusOptions(sessionId: string | null) {
  return queryOptions({
    queryKey: ['live-status', sessionId],
    queryFn: () => fetchLiveStatus(),
    enabled: sessionId !== null,
    refetchInterval: 5000,
  });
}
