import type { PrSnapshot } from '@diffity/github';

export interface PromptContext {
  snapshot: PrSnapshot;
  worktreePath: string;
  port: number;
  filter: string;
}

/**
 * The instructions handed to the preparing agent. It reviews ahead of the reviewer without ever
 * touching the forge, and reports back one of two verdicts on its last line so the daemon can tell
 * a finished review from a deliberate skip.
 */
export function composePrompt(ctx: PromptContext): string {
  const { snapshot, worktreePath, port, filter } = ctx;
  const lines = [
    'You are preparing a code review ahead of a human reviewer, so it is ready the moment they look.',
    '',
    `Pull request: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    `Author: ${snapshot.author}`,
    `Repository: ${snapshot.owner}/${snapshot.repo}, base ${snapshot.baseRef}`,
    `Size: +${snapshot.additions} -${snapshot.deletions} across ${snapshot.changedFiles} file(s)`,
    '',
    'A diffity review session for this pull request is already running. The checkout is at:',
    `  ${worktreePath}`,
    `and its server is on port ${port}. Pass --repo with that path to every diffity command, e.g.`,
    `  diffity --repo ${worktreePath} agent diff`,
    '',
    'NOTHING you do may reach GitHub. Leave only local review comments and a walkthrough; never run',
    'a command that posts, submits, approves, or requests changes on the pull request.',
    '',
  ];

  if (filter.trim()) {
    lines.push(
      'Before reviewing, decide whether this pull request is one the reviewer wants to see, using',
      'their own words:',
      '',
      indent(filter.trim()),
      '',
      'If it should be skipped, print exactly one line and stop, nothing else:',
      '  SKIP: <short reason>',
      '',
    );
  }

  lines.push(
    'Otherwise, prepare the review by following the diffity-review skill against this pull request:',
    'start the review, read the diff and the project standards, leave inline findings on the lines',
    'they belong to, add a short summary, set a reading-order walkthrough, and mark the review done.',
    'Do not open a browser.',
    '',
    'When the review is prepared, print exactly one final line and stop:',
    '  PREPARED',
  );

  return lines.join('\n') + '\n';
}

/** What the agent's run amounted to, read from the last verdict line it printed. */
export type Verdict =
  | { kind: 'prepared' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'none' };

export function verdictOf(stdout: string): Verdict {
  const lines = stdout.split('\n').map(line => line.trim()).filter(Boolean);
  // The last verdict wins, so a skill that echoes the instructions earlier cannot pre-empt it.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === 'PREPARED') {
      return { kind: 'prepared' };
    }
    const skip = /^SKIP:\s*(.*)$/.exec(line);
    if (skip) {
      return { kind: 'skipped', reason: skip[1].trim() || 'no reason given' };
    }
  }
  return { kind: 'none' };
}

function indent(text: string): string {
  return text.split('\n').map(line => `  ${line}`).join('\n');
}
