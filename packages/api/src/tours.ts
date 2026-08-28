export type TourStatus = 'building' | 'ready';

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
