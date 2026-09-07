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

/**
 * Whether the run ended on the reviewer's Claude session limit, and when that limit lifts. The
 * message either names a wall-clock time, sometimes with a zone — "resets 2pm (Europe/Stockholm)",
 * "resets at 14:30" — read here as the next moment that clock shows it, or names how long is left
 * — "resets in 90 minutes" — counted from now. `resetsAt` is null when the text names no time this
 * understands, which leaves the caller to pick its own retry.
 */
export function rateLimitOf(text: string, now: Date): { resetsAt: string | null } | null {
  if (!/hit your (?:session|usage) limit/i.test(text)) {
    return null;
  }
  return { resetsAt: resetsIn(text, now) ?? resetsAt(text, now) };
}

/** "resets in 3 hours", "resets in 45 minutes", "resets in 1 hour 30 minutes". */
function resetsIn(text: string, now: Date): string | null {
  const match = /resets\s+in\s+(?:(\d{1,3})\s*(?:hours|hour|hrs|hr|h)\b)?\s*(?:(\d{1,3})\s*(?:minutes|minute|mins|min|m)\b)?/i.exec(text);
  if (!match) {
    return null;
  }
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = match[2] ? Number(match[2]) : 0;
  if (hours === 0 && minutes === 0) {
    return null;
  }
  return new Date(now.getTime() + hours * 3_600_000 + minutes * 60_000).toISOString();
}

function resetsAt(text: string, now: Date): string | null {
  const match = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(\s*([A-Za-z0-9_+\-/]+)\s*\))?/i.exec(text);
  if (!match) {
    return null;
  }
  const [, rawHour, rawMinute, meridiem, zone] = match;
  const minute = rawMinute ? Number(rawMinute) : 0;
  let hour = Number(rawHour);
  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    hour = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59) {
    return null;
  }
  // Today if that time is still ahead in the zone the message named, tomorrow otherwise.
  for (const dayOffset of [0, 1]) {
    const at = wallClockInstant(now, zone ?? null, hour, minute, dayOffset);
    if (at > now.getTime()) {
      return new Date(at).toISOString();
    }
  }
  return null;
}

/** The instant at which a zone's clock reads this hour and minute, `dayOffset` days from now. */
function wallClockInstant(now: Date, zone: string | null, hour: number, minute: number, dayOffset: number): number {
  if (zone) {
    try {
      const [year, month, day] = zonedDate(zone, now);
      const wanted = Date.UTC(year, month - 1, day + dayOffset, hour, minute);
      // The offset is read at the guessed instant and then at the corrected one, so a reset that
      // falls on a daylight-saving change still lands on the clock time the message named.
      const once = wanted - zoneOffsetMs(zone, new Date(wanted));
      return wanted - zoneOffsetMs(zone, new Date(once));
    } catch {
      // Not a zone Intl knows (an abbreviation, say): the reviewer's own clock is the better guess.
    }
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute).getTime();
}

function zonedDate(zone: string, at: Date): [number, number, number] {
  const parts = zoneParts(zone, at);
  return [parts.year, parts.month, parts.day];
}

/** How far ahead of UTC the zone's clock is at that instant. */
function zoneOffsetMs(zone: string, at: Date): number {
  const { year, month, day, hour, minute, second } = zoneParts(zone, at);
  return Date.UTC(year, month - 1, day, hour, minute, second) - at.getTime();
}

function zoneParts(zone: string, at: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(part => part.type === type)?.value);
  return {
    year: value('year'), month: value('month'), day: value('day'),
    hour: value('hour') % 24, minute: value('minute'), second: value('second'),
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
