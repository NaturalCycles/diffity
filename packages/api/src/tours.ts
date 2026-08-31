import { memberOf } from './member.js';

export const TOUR_STATUSES = ['building', 'ready'] as const;
export type TourStatus = (typeof TOUR_STATUSES)[number];
export const isTourStatus = memberOf(TOUR_STATUSES);

export interface TourStep {
  id: string;
  tourId: string;
  sortOrder: number;
  filePath: string;
  startLine: number;
  endLine: number;
  body: string;
  annotation: string;
  createdAt: string;
}

export interface Tour {
  id: string;
  sessionId: string;
  topic: string;
  body: string;
  status: TourStatus;
  createdAt: string;
  steps: TourStep[];
}
