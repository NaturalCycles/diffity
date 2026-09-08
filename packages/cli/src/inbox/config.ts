import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/**
 * How the review agent is run. The command itself is built by `buildAgentArgv`, not configured:
 * the flags that keep the agent off the forge and out of the reviewer's own settings belong to the
 * daemon, and only these choices are left open.
 */
export interface AgentConfig {
  /** `--model`; null leaves the agent's own default. */
  model: string | null;
  /** `--effort`, one of low, medium, high, xhigh, max; null leaves the agent's own default. */
  effort: string | null;
  /**
   * The exact MCP tool names the agent may call. Empty runs it with no user settings at all — no
   * MCP servers, no memory, no installed skills. Anything listed brings the reviewer's MCP servers
   * back, with a hook refusing every MCP tool but these.
   */
  mcpAllow: string[];
  /** Appended verbatim to the built command. */
  extraArgs: string[];
  /** `--max-budget-usd` for one run; null leaves it uncapped. */
  maxBudgetUsd: number | null;
}

/**
 * The second pass over a drafted review: a stronger model reads the P1 and P2 findings against the
 * code and amends or dismisses the ones that do not hold. Off until a model is named.
 */
export interface ValidateConfig {
  /** The model that checks the drafted findings; null runs no second pass at all. */
  model: string | null;
  /** How long the check may take before the agent is stopped and the draft goes out unchecked. */
  timeoutMinutes: number;
  /** `--max-budget-usd` for the checking run; null leaves it uncapped. */
  maxBudgetUsd: number | null;
}

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
   * Regular-expression sources matched against the pull request title; a match skips the pull
   * request before an agent is spent on it.
   */
  skipTitles: string[];
  /**
   * The reviewer's own words on what needs their attention now. The preparing agent judges each
   * review against them and marks the ones that match, and the inbox page notifies for those only;
   * empty means every prepared review is worth a notification.
   */
  alertWhen: string;
  /**
   * Globs against the pull request's changed paths. A pull request touching one of them is marked
   * as needing the reviewer now, alongside whatever the agent made of `alertWhen`.
   */
  alertPaths: string[];
  /**
   * Whether the daemon posts the findings the agent named behind an `alertWhen` alert to the pull
   * request itself, as a comment review in the reviewer's name, at most once per head. An alert
   * raised by `alertPaths` posts nothing: it is the reviewer's own rule about the paths, and there
   * is nothing in it to tell the author.
   */
  postAlerts: boolean;
  /** Opens every posted comment, so nobody reads one as a verdict a human has stood behind. */
  postPrefix: string;
  agent: AgentConfig;
  validate: ValidateConfig;
  /** Whether a pull request waits for its CI to pass before an agent is spent on it. */
  waitForCi: boolean;
  prepareTimeoutMinutes: number;
  /**
   * How many prepared reviews may wait for the reviewer at once. Each preparation spends an agent
   * run, so the queue beyond this waits for a prepared review to be posted or dismissed.
   */
  maxPrepared: number;
  /**
   * Whether opening a prepared review also parks a live agent on it, answering what the reader asks
   * in the page — one agent run per question.
   */
  live: boolean;
  /** How long one answer may take before the agent is stopped. */
  liveTimeoutMinutes: number;
}

export const DEFAULT_INBOX_CONFIG: InboxConfig = {
  pollMinutes: 5,
  port: 5390,
  reposDir: '~/repos',
  worktreesDir: '~/.diffity/inbox/worktrees',
  filter: '',
  skipTitles: [],
  alertWhen: '',
  alertPaths: [],
  postAlerts: false,
  postPrefix: '[Automated AI pre-review, not yet checked by human]',
  agent: { model: null, effort: null, mcpAllow: [], extraArgs: [], maxBudgetUsd: null },
  validate: { model: null, timeoutMinutes: 15, maxBudgetUsd: null },
  waitForCi: false,
  prepareTimeoutMinutes: 30,
  maxPrepared: 5,
  live: true,
  liveTimeoutMinutes: 10,
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
  const config: InboxConfig = { ...DEFAULT_INBOX_CONFIG, alertPaths: [], skipTitles: [], agent: defaultAgent(), validate: defaultValidate() };

  if (obj.prepare !== undefined) {
    throw new Error(`${source}: "prepare" was replaced by the "agent" block — delete it (the built-in command applies) and put extra flags in agent.extraArgs`);
  }
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
  if (obj.skipTitles !== undefined) {
    config.skipTitles = parseSkipTitles(obj.skipTitles, source);
  }
  if (obj.alertWhen !== undefined) {
    if (typeof obj.alertWhen !== 'string') {
      throw new Error(`${source}: alertWhen must be a string`);
    }
    config.alertWhen = obj.alertWhen;
  }
  if (obj.alertPaths !== undefined) {
    if (!Array.isArray(obj.alertPaths) || !obj.alertPaths.every(glob => typeof glob === 'string' && glob.trim() !== '')) {
      throw new Error(`${source}: alertPaths must be an array of non-empty globs`);
    }
    config.alertPaths = (obj.alertPaths as string[]).map(glob => glob.trim());
  }
  if (obj.postAlerts !== undefined) {
    if (typeof obj.postAlerts !== 'boolean') {
      throw new Error(`${source}: postAlerts must be true or false`);
    }
    config.postAlerts = obj.postAlerts;
  }
  if (obj.postPrefix !== undefined) {
    if (typeof obj.postPrefix !== 'string') {
      throw new Error(`${source}: postPrefix must be a string`);
    }
    config.postPrefix = obj.postPrefix;
  }
  // Nothing goes to a pull request unprefixed: the prefix is what tells the author no human has
  // stood behind the finding yet.
  if (config.postAlerts && config.postPrefix.trim() === '') {
    throw new Error(`${source}: postPrefix must not be empty when postAlerts is on`);
  }
  if (obj.agent !== undefined) {
    config.agent = parseAgentConfig(obj.agent, source);
  }
  if (obj.validate !== undefined) {
    config.validate = parseValidateConfig(obj.validate, source);
  }
  if (obj.waitForCi !== undefined) {
    if (typeof obj.waitForCi !== 'boolean') {
      throw new Error(`${source}: waitForCi must be true or false`);
    }
    config.waitForCi = obj.waitForCi;
  }
  if (obj.prepareTimeoutMinutes !== undefined) {
    config.prepareTimeoutMinutes = positive(obj.prepareTimeoutMinutes, 'prepareTimeoutMinutes', source);
  }
  if (obj.maxPrepared !== undefined) {
    config.maxPrepared = positiveInteger(obj.maxPrepared, 'maxPrepared', source);
  }
  if (obj.live !== undefined) {
    if (typeof obj.live !== 'boolean') {
      throw new Error(`${source}: live must be true or false`);
    }
    config.live = obj.live;
  }
  if (obj.liveTimeoutMinutes !== undefined) {
    config.liveTimeoutMinutes = positive(obj.liveTimeoutMinutes, 'liveTimeoutMinutes', source);
  }
  return config;
}

/** Compiled here rather than at the first poll, so a typo is a refused config and not a lost skip. */
function parseSkipTitles(raw: unknown, source: string): string[] {
  if (!Array.isArray(raw) || !raw.every(pattern => typeof pattern === 'string' && pattern.trim() !== '')) {
    throw new Error(`${source}: skipTitles must be an array of non-empty regular expressions`);
  }
  return (raw as string[]).map((pattern, index) => {
    try {
      new RegExp(pattern);
    } catch (err) {
      throw new Error(`${source}: skipTitles[${index}] is not a valid regular expression: ${err instanceof Error ? err.message : err}`);
    }
    return pattern;
  });
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** An exact MCP tool name, as the reviewer's client reports it: mcp__<server>__<tool>. */
const MCP_TOOL_NAME = /^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/;

function defaultAgent(): AgentConfig {
  return { ...DEFAULT_INBOX_CONFIG.agent, mcpAllow: [], extraArgs: [] };
}

function parseAgentConfig(raw: unknown, source: string): AgentConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${source}: agent must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const agent = defaultAgent();

  if (obj.model !== undefined && obj.model !== null) {
    agent.model = text(obj.model, 'agent.model', source);
  }
  if (obj.effort !== undefined && obj.effort !== null) {
    const effort = text(obj.effort, 'agent.effort', source);
    if (!EFFORTS.includes(effort)) {
      throw new Error(`${source}: agent.effort must be one of ${EFFORTS.join('|')}`);
    }
    agent.effort = effort;
  }
  if (obj.mcpAllow !== undefined) {
    if (!Array.isArray(obj.mcpAllow) || !obj.mcpAllow.every(name => typeof name === 'string' && MCP_TOOL_NAME.test(name))) {
      throw new Error(`${source}: agent.mcpAllow must be an array of exact MCP tool names, like mcp__server__tool`);
    }
    agent.mcpAllow = obj.mcpAllow as string[];
  }
  if (obj.extraArgs !== undefined) {
    if (!Array.isArray(obj.extraArgs) || !obj.extraArgs.every(arg => typeof arg === 'string' && arg !== '')) {
      throw new Error(`${source}: agent.extraArgs must be an array of non-empty strings`);
    }
    agent.extraArgs = obj.extraArgs as string[];
  }
  if (obj.maxBudgetUsd !== undefined && obj.maxBudgetUsd !== null) {
    agent.maxBudgetUsd = positive(obj.maxBudgetUsd, 'agent.maxBudgetUsd', source);
  }
  return agent;
}

function defaultValidate(): ValidateConfig {
  return { ...DEFAULT_INBOX_CONFIG.validate };
}

function parseValidateConfig(raw: unknown, source: string): ValidateConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${source}: validate must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const validate = defaultValidate();

  if (obj.model !== undefined && obj.model !== null) {
    validate.model = text(obj.model, 'validate.model', source);
  }
  if (obj.timeoutMinutes !== undefined) {
    validate.timeoutMinutes = positive(obj.timeoutMinutes, 'validate.timeoutMinutes', source);
  }
  if (obj.maxBudgetUsd !== undefined && obj.maxBudgetUsd !== null) {
    validate.maxBudgetUsd = positive(obj.maxBudgetUsd, 'validate.maxBudgetUsd', source);
  }
  return validate;
}

/** The settings the inbox page edits, kept in the config file beside the keys only the file holds. */
export type InboxSettings = Pick<InboxConfig, 'filter' | 'skipTitles' | 'alertWhen' | 'alertPaths' | 'postAlerts' | 'postPrefix' | 'maxPrepared' | 'pollMinutes' | 'live' | 'liveTimeoutMinutes' | 'prepareTimeoutMinutes' | 'waitForCi' | 'agent' | 'validate'>;

/**
 * Writes the page-editable settings into the config file, leaving every other key as the reviewer
 * wrote it. A file that is missing or unreadable starts from nothing rather than from the defaults,
 * so a later load still fills those in.
 */
export function saveInboxSettings(path: string, settings: InboxSettings): void {
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch { /* rewritten below from what is known */ }
  }
  Object.assign(raw, settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
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
