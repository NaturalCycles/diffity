import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';

export interface LiveStatus {
  enabled: boolean;
  listening: boolean;
  /** An agent has taken a request for this review and not answered it yet. */
  working: boolean;
  waiting: number;
  /** Whether the agent may edit code here, derived from who wrote the pull request. */
  mayChangeCode: boolean;
}

/**
 * Kept apart from the repo info on purpose. This changes as an agent arms and answers, and putting
 * it on the info payload gave that object a new identity each time — which re-rendered everything
 * that reads it, for a dot in the toolbar.
 */
export function liveStatusOptions(ref?: string) {
  return queryOptions({
    queryKey: ['live-status', ref ?? null],
    queryFn: () => apiFetch<LiveStatus>(ref ? `/api/live/status?ref=${encodeURIComponent(ref)}` : '/api/live/status'),
    refetchInterval: 3000,
  });
}
