import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { buildAgentArgv, shellQuote, skillBody } from '../src/inbox/agent-argv.js';
import { parseAgentOutput, rateLimitOf } from '../src/inbox/agent-output.js';
import { allowFromEnv, mcpGateDecision } from '../src/inbox/mcp-gate.js';
import { DEFAULT_INBOX_CONFIG, type AgentConfig } from '../src/inbox/config.js';

const DIST_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  return { ...DEFAULT_INBOX_CONFIG.agent, mcpAllow: [], extraArgs: [], ...over };
}

function argv(over: Partial<AgentConfig> = {}, systemPrompt: string | null = null): string[] {
  return buildAgentArgv({ nodePath: '/usr/bin/node', entry: '/opt/diffity/index.js', agent: agent(over), systemPrompt });
}

/** The value of a flag in a built argv, so a test names the flag rather than an index. */
function valueOf(built: string[], flag: string): string | undefined {
  const at = built.indexOf(flag);
  return at === -1 ? undefined : built[at + 1];
}

describe('buildAgentArgv', () => {
  it('runs claude with JSON output and no user settings at all when no MCP tool is allowed', () => {
    const built = argv();
    expect(built.slice(0, 6)).toEqual(['claude', '-p', '--dangerously-skip-permissions', '--output-format', 'json', '--setting-sources']);
    expect(valueOf(built, '--setting-sources')).toBe('');
    expect(built).not.toContain('--settings');
    expect(built).not.toContain('--append-system-prompt');
    expect(built).not.toContain('--model');
    expect(built).not.toContain('--effort');
    expect(built).not.toContain('--max-budget-usd');
  });

  it('denies the gh writes and the package managers CI has already run', () => {
    const built = argv();
    expect(built).toContain('--disallowedTools');
    expect(built.slice(built.indexOf('--disallowedTools') + 1)).toEqual([
      'Bash(gh pr review:*)', 'Bash(gh pr comment:*)', 'Bash(gh pr merge:*)', 'Bash(gh api:*)',
      'Bash(pnpm:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(yarn:*)', 'Bash(bun:*)', 'Bash(make:*)',
    ]);
  });

  it('keeps the user MCP servers behind the gate hook when a tool is allowed', () => {
    const built = argv({ mcpAllow: ['mcp__claude_ai_Atlassian__getJiraIssue'] });
    expect(valueOf(built, '--setting-sources')).toBe('user');

    const settings = JSON.parse(valueOf(built, '--settings')!);
    expect(settings).toEqual({
      hooks: {
        PreToolUse: [{
          matcher: 'mcp__.*',
          hooks: [{ type: 'command', command: "'/usr/bin/node' '/opt/diffity/index.js' inbox mcp-gate" }],
        }],
      },
    });
  });

  it('quotes the hook command, so a path with a space or a quote survives the shell', () => {
    const built = buildAgentArgv({
      nodePath: '/usr/bin/node', entry: "/home/o'brien/my tools/index.js",
      agent: agent({ mcpAllow: ['mcp__a__b'] }), systemPrompt: null,
    });
    const command = JSON.parse(valueOf(built, '--settings')!).hooks.PreToolUse[0].hooks[0].command;
    expect(command).toBe("'/usr/bin/node' '/home/o'\\''brien/my tools/index.js' inbox mcp-gate");
  });

  it('passes the model, the effort, the budget, the system prompt and the extra args', () => {
    const built = argv({ model: 'opus', effort: 'high', maxBudgetUsd: 2.5, extraArgs: ['--verbose', '--foo'] }, 'REVIEW INSTRUCTIONS');
    expect(valueOf(built, '--model')).toBe('opus');
    expect(valueOf(built, '--effort')).toBe('high');
    expect(valueOf(built, '--max-budget-usd')).toBe('2.5');
    // One argv element, whatever its size, so the skill body needs no quoting of its own.
    expect(valueOf(built, '--append-system-prompt')).toBe('REVIEW INSTRUCTIONS');
    expect(built.slice(built.indexOf('--verbose'), built.indexOf('--verbose') + 2)).toEqual(['--verbose', '--foo']);
  });

  it('keeps the extra args out of the deny list, whatever they are', () => {
    // The deny list is variadic, so a value-shaped extra arg after it would be read as a tool.
    const built = argv({ extraArgs: ['--add-dir', '/tmp/context'] });
    expect(built.indexOf('--add-dir')).toBeLessThan(built.indexOf('--disallowedTools'));
    expect(built.slice(built.indexOf('--disallowedTools') + 1)).not.toContain('/tmp/context');
  });
});

describe('shellQuote', () => {
  it('single-quotes a path and closes the quote around an embedded one', () => {
    expect(shellQuote('/plain/path')).toBe("'/plain/path'");
    expect(shellQuote("it's here")).toBe("'it'\\''s here'");
  });
});

describe('skillBody', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'diffity-skill-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function ship(name: string, body: string): void {
    mkdirSync(join(root, 'skills', name), { recursive: true });
    writeFileSync(join(root, 'skills', name, 'SKILL.md'), body);
  }

  it('reads the skill shipped beside the entry and strips its frontmatter', () => {
    ship('diffity-review', '---\nname: diffity-review\ndescription: Review\n---\n\n# Diffity Review Skill\n\nStep 0.\n');
    ship('diffity-live', '---\nname: diffity-live\n---\n\n# Diffity Live Skill\n\nAnswer it.\n');

    expect(skillBody(join(root, 'index.js'), 'diffity-review')).toBe('# Diffity Review Skill\n\nStep 0.\n');
    expect(skillBody(join(root, 'index.js'), 'diffity-live')).toBe('# Diffity Live Skill\n\nAnswer it.\n');
  });

  it('leaves a body without frontmatter alone', () => {
    ship('diffity-review', '# No frontmatter\n');
    expect(skillBody(join(root, 'index.js'), 'diffity-review')).toBe('# No frontmatter\n');
  });

  it('warns by name and hands back nothing when the skill is not shipped', () => {
    const warnings: string[] = [];
    const log = (message: string) => { warnings.push(message); };
    expect(skillBody(join(root, 'index.js'), 'diffity-review', log)).toBeNull();
    expect(skillBody(join(root, 'index.js'), 'diffity-live', log)).toBeNull();
    expect(warnings[0]).toContain('diffity-review');
    expect(warnings[1]).toContain('diffity-live');
  });

  it('is shipped with this build for both passes', () => {
    // The daemon reads these from its own dist, so a build that stops shipping one would leave the
    // agent with no instructions at all.
    for (const name of ['diffity-review', 'diffity-live'] as const) {
      expect(skillBody(DIST_ENTRY, name, () => {})).toContain('# Diffity');
    }
  });
});

describe('mcpGateDecision', () => {
  const allow = ['mcp__claude_ai_Atlassian__getJiraIssue'];

  it('lets a built-in tool and an allowed MCP tool through', () => {
    expect(mcpGateDecision({ tool_name: 'Bash' }, allow)).toEqual({ allow: true });
    expect(mcpGateDecision({ tool_name: 'Read' }, [])).toEqual({ allow: true });
    expect(mcpGateDecision({ tool_name: 'mcp__claude_ai_Atlassian__getJiraIssue' }, allow)).toEqual({ allow: true });
  });

  it('refuses an MCP tool that is not allowed, naming what is', () => {
    expect(mcpGateDecision({ tool_name: 'mcp__gcloud__run_gcloud_command' }, allow)).toEqual({
      allow: false,
      message: 'the review agent may only use mcp__claude_ai_Atlassian__getJiraIssue; mcp__gcloud__run_gcloud_command is not allowed',
    });
  });

  it('refuses every MCP tool when nothing is allowed', () => {
    expect(mcpGateDecision({ tool_name: 'mcp__a__b' }, [])).toEqual({
      allow: false,
      message: 'the review agent may only use no MCP tools; mcp__a__b is not allowed',
    });
  });

  it('refuses a payload it cannot read rather than assuming the call is safe', () => {
    for (const input of [null, undefined, 'not json at all', [], {}, { tool_name: 42 }, { tool_name: '' }]) {
      const decision = mcpGateDecision(input, allow);
      expect(decision.allow).toBe(false);
      expect(decision.allow === false && decision.message).toContain('could not be read');
    }
  });
});

describe('diffity inbox mcp-gate', () => {
  /** The hook as the agent runs it: the payload on stdin, the allowlist in the environment. */
  function gate(payload: string, allow: string | undefined): Promise<{ code: number | null; stderr: string }> {
    const env = { ...process.env };
    if (allow === undefined) {
      delete env.DIFFITY_MCP_ALLOW;
    } else {
      env.DIFFITY_MCP_ALLOW = allow;
    }
    return new Promise(resolve => {
      const child = spawn(process.execPath, [DIST_ENTRY, 'inbox', 'mcp-gate'], { stdio: ['pipe', 'pipe', 'pipe'], env });
      let stderr = '';
      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.stdin.end(payload);
      child.on('close', code => resolve({ code, stderr }));
    });
  }

  it('refuses an MCP tool that is not allowed, on its exit code and on stderr', async () => {
    const { code, stderr } = await gate('{"tool_name":"mcp__x__y"}', 'mcp__a__b');
    expect(code).toBe(2);
    expect(stderr).toContain('the review agent may only use mcp__a__b; mcp__x__y is not allowed');
  });

  it('lets an allowed MCP tool and a built-in tool through', async () => {
    expect((await gate('{"tool_name":"mcp__a__b"}', 'mcp__a__b')).code).toBe(0);
    expect((await gate('{"tool_name":"Bash"}', 'mcp__a__b')).code).toBe(0);
    expect((await gate('{"tool_name":"Bash"}', undefined)).code).toBe(0);
  });

  it('refuses everything MCP when the allowlist is empty, and a payload it cannot read', async () => {
    expect((await gate('{"tool_name":"mcp__a__b"}', '')).code).toBe(2);
    const unreadable = await gate('not json', 'mcp__a__b');
    expect(unreadable.code).toBe(2);
    expect(unreadable.stderr).toContain('could not be read');
  });
});

describe('allowFromEnv', () => {
  it('reads the comma-separated list, and nothing from nothing', () => {
    expect(allowFromEnv(undefined)).toEqual([]);
    expect(allowFromEnv('')).toEqual([]);
    expect(allowFromEnv('mcp__a__b, mcp__c__d,')).toEqual(['mcp__a__b', 'mcp__c__d']);
  });
});

describe('parseAgentOutput', () => {
  it('reads the text and the stats out of a result object', () => {
    const stdout = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'reviewing\nPREPARED',
      total_cost_usd: 1.23, duration_ms: 521_000, num_turns: 37,
      usage: { input_tokens: 12, output_tokens: 27_000, cache_read_input_tokens: 1_100_000, cache_creation_input_tokens: 76_000 },
      modelUsage: { 'claude-sonnet-4-6': {}, 'claude-haiku-4-6': {} },
    });

    expect(parseAgentOutput(`\n${stdout}\n`)).toEqual({
      text: 'reviewing\nPREPARED',
      stats: {
        costUsd: 1.23, durationMs: 521_000, turns: 37, inputTokens: 12, outputTokens: 27_000,
        cacheReadTokens: 1_100_000, cacheWriteTokens: 76_000,
        models: ['claude-sonnet-4-6', 'claude-haiku-4-6'], isError: false, subtype: 'success',
      },
    });
  });

  it('fills the counts and leaves the rest null when the result says little', () => {
    expect(parseAgentOutput(JSON.stringify({ type: 'result' }))).toEqual({
      text: '',
      stats: {
        costUsd: null, durationMs: null, turns: null, inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, models: [], isError: false, subtype: null,
      },
    });
  });

  it('flags a run that hit its budget', () => {
    const parsed = parseAgentOutput(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, result: '' }));
    expect(parsed.stats?.subtype).toBe('error_max_budget_usd');
    expect(parsed.stats?.isError).toBe(true);
  });

  it('takes anything that is not a result object as the text itself', () => {
    expect(parseAgentOutput('reviewing\nPREPARED\n')).toEqual({ text: 'reviewing\nPREPARED\n', stats: null });
    expect(parseAgentOutput('{ not json')).toEqual({ text: '{ not json', stats: null });
    expect(parseAgentOutput('[]')).toEqual({ text: '[]', stats: null });
    expect(parseAgentOutput(JSON.stringify({ type: 'assistant', result: 'PREPARED' })))
      .toEqual({ text: JSON.stringify({ type: 'assistant', result: 'PREPARED' }), stats: null });
    expect(parseAgentOutput('')).toEqual({ text: '', stats: null });
  });
});

describe('rateLimitOf', () => {
  const limit = "Claude AI usage limit reached. You've hit your session limit \u00b7 resets 2pm (Europe/Stockholm)";

  it('says nothing about a run that did not hit a limit', () => {
    expect(rateLimitOf('reviewing\nPREPARED', new Date('2026-09-07T09:00:00Z'))).toBeNull();
    expect(rateLimitOf('the rate of change here is high', new Date('2026-09-07T09:00:00Z'))).toBeNull();
  });

  it('reads the reset time in the zone the message named, today or tomorrow', () => {
    // 11:00 in Stockholm, so 14:00 there is still ahead: today, 12:00 UTC.
    expect(rateLimitOf(limit, new Date('2026-09-07T09:00:00Z'))).toEqual({ resetsAt: '2026-09-07T12:00:00.000Z' });
    // 15:00 in Stockholm: the next 14:00 there is tomorrow.
    expect(rateLimitOf(limit, new Date('2026-09-07T13:00:00Z'))).toEqual({ resetsAt: '2026-09-08T12:00:00.000Z' });
  });

  it('follows the zone through its winter offset', () => {
    expect(rateLimitOf(limit, new Date('2026-01-15T09:00:00Z'))).toEqual({ resetsAt: '2026-01-15T13:00:00.000Z' });
  });

  it('reads a 24-hour time and a time with minutes', () => {
    const stockholm = "You've hit your usage limit, resets 06:30 (Europe/Stockholm)";
    expect(rateLimitOf(stockholm, new Date('2026-09-07T00:00:00Z'))).toEqual({ resetsAt: '2026-09-07T04:30:00.000Z' });
    const newYork = "You've hit your session limit \u00b7 resets 2:15pm (America/New_York)";
    expect(rateLimitOf(newYork, new Date('2026-09-07T10:00:00Z'))).toEqual({ resetsAt: '2026-09-07T18:15:00.000Z' });
  });

  it('reads a time with no zone on the reviewer\'s own clock', () => {
    const now = new Date('2026-09-07T09:00:00Z');
    const parsed = rateLimitOf("You've hit your session limit \u00b7 resets 23:45", now);
    const at = new Date(parsed!.resetsAt!);
    expect([at.getHours(), at.getMinutes()]).toEqual([23, 45]);
    expect(at.getTime()).toBeGreaterThan(now.getTime());
  });

  it('reads a time introduced with "at"', () => {
    expect(rateLimitOf("You've hit your session limit \u00b7 resets at 2pm (Europe/Stockholm)", new Date('2026-09-07T09:00:00Z')))
      .toEqual({ resetsAt: '2026-09-07T12:00:00.000Z' });
    expect(rateLimitOf("You've hit your usage limit, resets at 06:30 (Europe/Stockholm)", new Date('2026-09-07T00:00:00Z')))
      .toEqual({ resetsAt: '2026-09-07T04:30:00.000Z' });
  });

  it('counts forward from now when the message says how long is left', () => {
    const now = new Date('2026-09-07T09:00:00Z');
    expect(rateLimitOf("You've hit your session limit \u00b7 resets in 3 hours", now)).toEqual({ resetsAt: '2026-09-07T12:00:00.000Z' });
    expect(rateLimitOf("You've hit your usage limit, resets in 45 minutes", now)).toEqual({ resetsAt: '2026-09-07T09:45:00.000Z' });
    expect(rateLimitOf("You've hit your session limit \u00b7 resets in 1 hour 30 minutes", now)).toEqual({ resetsAt: '2026-09-07T10:30:00.000Z' });
    expect(rateLimitOf("You've hit your session limit \u00b7 resets in 90 mins", now)).toEqual({ resetsAt: '2026-09-07T10:30:00.000Z' });
    expect(rateLimitOf("You've hit your session limit \u00b7 resets in 1 hr", now)).toEqual({ resetsAt: '2026-09-07T10:00:00.000Z' });
  });

  it('flags the limit with no time when the message names none it can read', () => {
    for (const text of [
      "You've hit your session limit",
      "You've hit your session limit \u00b7 resets soon",
      "You've hit your session limit \u00b7 resets in a while",
      "You've hit your session limit \u00b7 resets 25:00",
      "You've hit your session limit \u00b7 resets 13pm",
    ]) {
      expect(rateLimitOf(text, new Date('2026-09-07T09:00:00Z'))).toEqual({ resetsAt: null });
    }
  });

  it('falls back to the local clock when the zone is not one Intl knows', () => {
    const now = new Date('2026-09-07T09:00:00Z');
    const parsed = rateLimitOf("You've hit your session limit \u00b7 resets 2pm (Middle/Earth)", now);
    const at = new Date(parsed!.resetsAt!);
    expect([at.getHours(), at.getMinutes()]).toEqual([14, 0]);
  });
});
