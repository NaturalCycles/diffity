import { execFileSync } from 'node:child_process';
import { execSync } from 'node:child_process';

export function exec(cmd: string): string {
  return execSync(cmd, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function execJson<T>(cmd: string): T | null {
  try {
    const raw = exec(cmd);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
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
 */
export function gh(args: string[]): string {
  return execFileSync('gh', args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: MAX_BUFFER,
  }).trim();
}

export function ghJson<T>(args: string[]): T | null {
  try {
    const raw = gh(args);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
