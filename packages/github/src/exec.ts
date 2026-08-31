import { execFile, execFileSync } from 'node:child_process';
import { execSync } from 'node:child_process';

export function exec(cmd: string): string {
  return execSync(cmd, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function execSilent(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Runs gh without a shell. Owner and repository names come from a remote URL, which a submodule
 * in a pull request controls, so they must never be interpolated into a command string.
 *
 * A failure throws with the reason first: execFileSync's own error leads with the full command
 * line — which can embed a whole GraphQL query — before any stderr, and an ENOENT carries no
 * stderr at all. Callers that treat a failure as "no" keep catching; wherever the error
 * surfaces, gh's own words lead it.
 */
export function gh(args: string[]): string {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    }).trim();
  } catch (error) {
    throw new Error(describeGhFailure(args, error), { cause: error });
  }
}

function describeGhFailure(args: string[], error: unknown): string {
  const what = `gh ${args.slice(0, 2).join(' ')}`;
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === 'string' ? stderr : stderr instanceof Buffer ? stderr.toString('utf-8') : '';
  const lines = text.split('\n');
  // gh prefixes its own summary with "gh:", and that line says more than whatever precedes it.
  const reason = lines.find(line => line.trimStart().startsWith('gh:'))?.trim()
    ?? lines.find(line => line.trim())?.trim()
    ?? (error instanceof Error ? error.message : String(error));
  return `${what} failed: ${reason}`;
}

/**
 * The async twin of `gh`, for callers on the server's event loop: a slow forge answer must not
 * stall every poll and heartbeat the server is carrying. Same arguments, same failure shape.
 */
export function ghAsync(
  args: string[],
  options: { input?: string; maxBuffer?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      args,
      { encoding: 'utf-8', maxBuffer: options.maxBuffer ?? MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(describeGhFailure(args, Object.assign(error, { stderr })), { cause: error }));
          return;
        }
        resolve(stdout.trim());
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

/** Whether a gh call succeeds, without blocking and without caring what it says. */
export function ghSucceeds(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('gh', args, { encoding: 'utf-8' }, (error) => resolve(!error));
  });
}
