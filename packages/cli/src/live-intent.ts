import type { LiveIntent } from '@diffity/api';

export type { LiveIntent } from '@diffity/api';

/** Anything not plainly `act` is a question: least privilege, and it covers old and malformed alike. */
export function normaliseIntent(value: unknown): LiveIntent {
  return value === 'act' ? 'act' : 'ask';
}

/** Said in plain language, because that is what the agent acts on. */
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
