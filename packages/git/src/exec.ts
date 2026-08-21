import {
  execFileSync,
  execSync,
  type StdioOptions,
} from 'node:child_process';

const STDIO: StdioOptions = ['pipe', 'pipe', 'pipe'];

/**
 * Node's default is 1 MB, which is smaller than a large repository's file
 * listing: `git ls-files` in a ~29k-file monorepo emits over 2 MB and the child
 * process dies with ENOBUFS.
 */
const MAX_BUFFER = 50 * 1024 * 1024;

export function execWithStdin(cmd: string, input: string): string {
  return execSync(cmd, {
    encoding: 'utf-8',
    stdio: STDIO,
    input,
    maxBuffer: MAX_BUFFER,
  });
}

export function exec(cmd: string): string {
  return execSync(cmd, {
    encoding: 'utf-8',
    stdio: STDIO,
  }).trim();
}

export function execLarge(cmd: string): string {
  return execSync(cmd, {
    encoding: 'utf-8',
    stdio: STDIO,
    maxBuffer: MAX_BUFFER,
  });
}

/**
 * The argv form of `execLarge`, for commands whose arguments come from user
 * input — a path with a space or a quote in it cannot be passed safely through
 * a shell string.
 */
export function execFileLarge(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf-8',
    stdio: STDIO,
    maxBuffer: MAX_BUFFER,
  }).trim();
}

/**
 * Runs git without a shell. Preferred over the string forms for anything whose arguments
 * come from a ref, a path or a search term.
 */
export function git(args: string[]): string {
  return execFileLarge('git', args);
}

export function gitWithStdin(args: string[], input: string): string {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    stdio: STDIO,
    input,
    maxBuffer: MAX_BUFFER,
  });
}

export function gitLines(args: string[]): string[] {
  const output = git(args);
  if (!output) {
    return [];
  }
  return output.split('\n');
}

export function execLines(cmd: string): string[] {
  const output = exec(cmd);
  if (!output) {
    return [];
  }
  return output.split('\n');
}
