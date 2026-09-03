import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

export interface InboxConfig {
  /** How often GitHub is asked; well inside its limits at a handful of calls per tick. */
  pollMinutes: number;
  port: number;
  /** Where the base clones live, one directory per repository name. */
  reposDir: string;
  /** Where each pull request gets its own worktree. */
  worktreesDir: string;
  /**
   * The reviewer's own words on what does and does not need their attention, handed to the
   * preparing agent verbatim. Empty means everything asked of the reviewer is prepared.
   */
  filter: string;
  /**
   * The agent, as argv; it runs in the pull request's worktree and reads its prompt on stdin. That
   * worktree is code the pull request's author controls, so the daemon runs the agent without the
   * forge's credentials in its environment — but the command itself still executes attacker-chosen
   * repository scripts, so only point it at an agent you would run on an untrusted checkout.
   */
  prepare: string[];
  prepareTimeoutMinutes: number;
  /**
   * How many prepared reviews may wait for the reviewer at once. Each preparation spends an agent
   * run, so the queue beyond this waits for a prepared review to be posted or dismissed.
   */
  maxPrepared: number;
}

export const DEFAULT_INBOX_CONFIG: InboxConfig = {
  pollMinutes: 5,
  port: 5390,
  reposDir: '~/repos',
  worktreesDir: '~/.diffity/inbox/worktrees',
  filter: '',
  // Defence in depth on top of the stripped credentials: the agent is also denied the gh commands
  // that could reach the pull request even if it tried.
  prepare: [
    'claude', '-p', '--dangerously-skip-permissions',
    '--disallowedTools', 'Bash(gh pr review:*)', 'Bash(gh pr comment:*)', 'Bash(gh pr merge:*)', 'Bash(gh api:*)',
  ],
  prepareTimeoutMinutes: 30,
  maxPrepared: 5,
};

/**
 * Reads the config, writing the defaults first when there is none yet, so the reviewer finds a
 * file to edit rather than a schema to guess. Missing keys take their defaults; wrong ones are
 * refused by name.
 */
export function loadInboxConfig(path: string): InboxConfig {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(DEFAULT_INBOX_CONFIG, null, 2) + '\n');
    return expandPaths(DEFAULT_INBOX_CONFIG);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  return expandPaths(parseInboxConfig(raw, path));
}

export function parseInboxConfig(raw: unknown, source = 'inbox config'): InboxConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${source} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const config: InboxConfig = { ...DEFAULT_INBOX_CONFIG };

  if (obj.pollMinutes !== undefined) {
    config.pollMinutes = positive(obj.pollMinutes, 'pollMinutes', source);
  }
  if (obj.port !== undefined) {
    config.port = port(obj.port, source);
  }
  if (obj.reposDir !== undefined) {
    config.reposDir = text(obj.reposDir, 'reposDir', source);
  }
  if (obj.worktreesDir !== undefined) {
    config.worktreesDir = text(obj.worktreesDir, 'worktreesDir', source);
  }
  if (obj.filter !== undefined) {
    if (typeof obj.filter !== 'string') {
      throw new Error(`${source}: filter must be a string`);
    }
    config.filter = obj.filter;
  }
  if (obj.prepare !== undefined) {
    if (!Array.isArray(obj.prepare) || obj.prepare.length === 0 || !obj.prepare.every(part => typeof part === 'string' && part !== '')) {
      throw new Error(`${source}: prepare must be a non-empty array of strings (a command and its arguments)`);
    }
    config.prepare = obj.prepare as string[];
  }
  if (obj.prepareTimeoutMinutes !== undefined) {
    config.prepareTimeoutMinutes = positive(obj.prepareTimeoutMinutes, 'prepareTimeoutMinutes', source);
  }
  if (obj.maxPrepared !== undefined) {
    config.maxPrepared = positiveInteger(obj.maxPrepared, 'maxPrepared', source);
  }
  return config;
}

function positive(value: unknown, key: string, source: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${source}: ${key} must be a positive number`);
  }
  return value;
}

function positiveInteger(value: unknown, key: string, source: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${source}: ${key} must be a positive integer`);
  }
  return value;
}

function port(value: unknown, source: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${source}: port must be an integer between 1 and 65535`);
  }
  return value;
}

function text(value: unknown, key: string, source: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${source}: ${key} must be a non-empty string`);
  }
  return value;
}

function expandPaths(config: InboxConfig): InboxConfig {
  return {
    ...config,
    reposDir: expandHome(config.reposDir),
    worktreesDir: expandHome(config.worktreesDir),
  };
}

export function expandHome(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return isAbsolute(path) ? path : join(process.cwd(), path);
}
