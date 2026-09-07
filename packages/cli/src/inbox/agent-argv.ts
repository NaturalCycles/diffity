import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentConfig } from './config.js';

export interface AgentArgvOpts {
  nodePath: string;
  /** This CLI's own bundle, which the MCP gate is invoked through and the skill is read beside. */
  entry: string;
  agent: AgentConfig;
  /** Appended to the agent's system prompt; the review skill for a drafting pass, null otherwise. */
  systemPrompt: string | null;
}

/**
 * What the agent may not run: the gh commands that could reach the pull request even with the
 * credentials stripped, and the toolchains CI has already run on this head — installing or
 * building would execute the author's scripts for nothing.
 */
const DISALLOWED_TOOLS = [
  'Bash(gh pr review:*)', 'Bash(gh pr comment:*)', 'Bash(gh pr merge:*)', 'Bash(gh api:*)',
  'Bash(pnpm:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(yarn:*)', 'Bash(bun:*)', 'Bash(make:*)',
];

/**
 * The review agent's command. The daemon builds it rather than taking it from the config, because
 * these flags are what the "the agent reads an untrusted checkout and never reaches the forge"
 * promise rests on: no user settings — so no MCP servers, no memory, no installed skills — unless
 * the reviewer allowlisted MCP tools, in which case every MCP call goes through `inbox mcp-gate`.
 */
export function buildAgentArgv(opts: AgentArgvOpts): string[] {
  const { nodePath, entry, agent, systemPrompt } = opts;
  const gated = agent.mcpAllow.length > 0;
  return [
    'claude', '-p', '--dangerously-skip-permissions', '--output-format', 'json',
    '--setting-sources', gated ? 'user' : '',
    ...(gated ? ['--settings', JSON.stringify(gateSettings(nodePath, entry))] : []),
    ...(systemPrompt ? ['--append-system-prompt', systemPrompt] : []),
    ...(agent.model ? ['--model', agent.model] : []),
    ...(agent.effort ? ['--effort', agent.effort] : []),
    ...(agent.maxBudgetUsd ? ['--max-budget-usd', String(agent.maxBudgetUsd)] : []),
    ...agent.extraArgs,
    // Last, and only ever followed by its own values: `--disallowedTools` takes a variadic, so
    // anything after it would be read as another denied tool. This list starts with `--`, which
    // ends a variadic the reviewer's own extra args may have opened.
    '--disallowedTools', ...DISALLOWED_TOOLS,
  ];
}

/** A PreToolUse hook on every MCP tool; exiting 2 refuses the call, permissions off or not. */
function gateSettings(nodePath: string, entry: string): unknown {
  return {
    hooks: {
      PreToolUse: [{
        matcher: 'mcp__.*',
        hooks: [{ type: 'command', command: `${shellQuote(nodePath)} ${shellQuote(entry)} inbox mcp-gate` }],
      }],
    },
  };
}

/** The hook command is a shell line, so a path with a space or a quote in it has to survive one. */
export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/** The skills the daemon puts in an agent's system prompt: the review pass's and the answer pass's. */
export type InboxSkill = 'diffity-review' | 'diffity-live';

/**
 * A skill shipped beside this build, frontmatter stripped, for the agent's system prompt. Reading
 * it here is what lets the agent run with no installed skills at all; without the file it has to
 * fall back on the reviewer's own.
 */
export function skillBody(entry: string, name: InboxSkill, log: (message: string) => void = console.warn): string | null {
  const path = join(dirname(entry), 'skills', name, 'SKILL.md');
  if (!existsSync(path)) {
    log(`the ${name} skill is not at ${path}; the agent falls back on the skills you have installed`);
    return null;
  }
  return stripFrontmatter(readFileSync(path, 'utf-8'));
}

function stripFrontmatter(body: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(body);
  return match ? body.slice(match[0].length).trimStart() : body;
}
