interface CommentLike {
  id: string;
  liveRequestedAt?: string | null;
  liveAnsweredAt?: string | null;
}

/**
 * A request on this thread that has been made and never answered.
 *
 * Answering is what closes a request, and it is a separate act from replying: stale claims are
 * re-armed every few minutes, so a request left open comes back round and the agent is handed a
 * question it has already answered, with nothing to say it has.
 */
export function unansweredRequest(comments: CommentLike[]): string | null {
  const open = comments.find(comment => comment.liveRequestedAt && !comment.liveAnsweredAt);
  return open?.id ?? null;
}
