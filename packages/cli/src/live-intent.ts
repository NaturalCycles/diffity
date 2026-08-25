/** What the reader pressed: a question, or a request for a change. */
export type LiveIntent = 'ask' | 'act';

/**
 * Anything that does not plainly say `act` is a question. Least privilege, and it covers both
 * requests written before intent existed and anything malformed arriving at the route.
 */
export function normaliseIntent(value: unknown): LiveIntent {
  return value === 'act' ? 'act' : 'ask';
}

/**
 * What the agent is told on waking. The intent is a field rather than words mixed into the comment,
 * so the reader's text stays theirs — but the instruction still has to be said in plain language,
 * because that is what the agent acts on.
 */
export function directiveFor(intent: LiveIntent, mayChangeCode: boolean): string {
  if (intent === 'ask') {
    return 'The reader asked a question. Answer it in the thread, or amend the finding it is about. '
      + 'Do not change code — they pressed Ask, not Act.';
  }

  if (!mayChangeCode) {
    return 'The reader asked for a change, but this pull request is somebody else\'s. '
      + 'Do not change code. Answer in the thread, or amend the finding, and say that is why.';
  }

  return 'The reader asked for a change. Read it, make the change, and reply in the thread with what '
    + 'you did. Do not commit, push or merge.';
}
