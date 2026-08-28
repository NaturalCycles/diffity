import type { CommentSide, LiveIntent } from './threads.js';

/**
 * A question or an instruction the reader left for the agent, taken from the comment it was written
 * as. The request is the comment: a separate queue would be a second thing to keep in step with the
 * thread it belongs to, and would not survive a commit the way a comment does.
 */
export interface LiveRequest {
  commentId: string;
  threadId: string;
  body: string;
  authorName: string;
  filePath: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
  /**
   * The finding the aside is about, so the agent can answer without another lookup. Null when the
   * thread has no finding.
   */
  findingBody: string | null;
  /** Whether the agent may edit code for this request. Filled in by the route that hands it over. */
  mayChangeCode?: boolean;
  /** What the reader pressed. A question must not turn into an edit. */
  intent: LiveIntent;
}

export interface SinceLastWait {
  /** Findings that went to the forge while the agent was waiting. */
  submitted: number;
}

/** What `POST /api/live/claim` answers. */
export interface ClaimResponse {
  request: LiveRequest | null;
  since: SinceLastWait;
  viewerPresent: boolean;
  /** The page was open and has gone — not the same as never opened, which keeps waiting. */
  viewerGone: boolean;
}

/** What `GET /api/live/status` answers. */
export interface LiveStatusResponse {
  enabled: boolean;
  listening: boolean;
  working: boolean;
  waiting: number;
  mayChangeCode: boolean;
  viewerPresent: boolean;
}
