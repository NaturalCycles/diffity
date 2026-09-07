/** What one agent run spent, as `--output-format json` reports it. */
export interface RunStats {
  costUsd: number | null;
  durationMs: number | null;
  turns: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  models: string[];
  isError: boolean;
  /** The agent's own word for how the run ended, e.g. `success` or `error_max_budget_usd`. */
  subtype: string | null;
}

/**
 * The agent's stdout as the daemon needs it: the text it would have printed without
 * `--output-format json`, and what the run spent. Output that is not a result object is taken as
 * the text itself, so an agent run without the flag still yields a verdict.
 */
export function parseAgentOutput(stdout: string): { text: string; stats: RunStats | null } {
  const row = resultObject(stdout);
  if (!row) {
    return { text: stdout, stats: null };
  }
  const usage = objectAt(row.usage);
  const modelUsage = objectAt(row.modelUsage);
  return {
    text: typeof row.result === 'string' ? row.result : '',
    stats: {
      costUsd: numberOrNull(row.total_cost_usd),
      durationMs: numberOrNull(row.duration_ms),
      turns: numberOrNull(row.num_turns),
      inputTokens: numberOrNull(usage.input_tokens) ?? 0,
      outputTokens: numberOrNull(usage.output_tokens) ?? 0,
      cacheReadTokens: numberOrNull(usage.cache_read_input_tokens) ?? 0,
      cacheWriteTokens: numberOrNull(usage.cache_creation_input_tokens) ?? 0,
      models: Object.keys(modelUsage),
      isError: row.is_error === true,
      subtype: typeof row.subtype === 'string' ? row.subtype : null,
    },
  };
}

function resultObject(stdout: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  return row.type === 'result' ? row : null;
}

function objectAt(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
