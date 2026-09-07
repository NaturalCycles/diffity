import { parseInboxConfig, type InboxSettings } from './config.js';

/** Longer than any sensible instruction to an agent; a guard on the request, not a design limit. */
export const MAX_SETTINGS_TEXT = 4000;

export const SETTINGS_KEYS = ['filter', 'alertWhen', 'maxPrepared', 'pollMinutes', 'live', 'liveTimeoutMinutes', 'prepareTimeoutMinutes', 'agent'] as const;

export type SettingsPatch =
  | { ok: true; settings: InboxSettings }
  | { ok: false; message: string };

/**
 * The page's settings body: every editable key present, each validated the way the config file's
 * is — the same rules, the same messages — with a length guard on the free text.
 */
export function parseSettingsPatch(body: string): SettingsPatch {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, message: 'settings must be JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'settings must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of SETTINGS_KEYS) {
    if (obj[key] === undefined) {
      return { ok: false, message: `${key} is missing` };
    }
  }
  for (const key of ['filter', 'alertWhen'] as const) {
    if (typeof obj[key] !== 'string') {
      return { ok: false, message: `${key} must be a string` };
    }
    if ((obj[key] as string).length > MAX_SETTINGS_TEXT) {
      return { ok: false, message: `${key} is longer than ${MAX_SETTINGS_TEXT} characters` };
    }
  }
  try {
    const picked = Object.fromEntries(SETTINGS_KEYS.map(key => [key, obj[key]]));
    const parsed = parseInboxConfig(picked, 'settings');
    return { ok: true, settings: Object.fromEntries(SETTINGS_KEYS.map(key => [key, parsed[key]])) as unknown as InboxSettings };
  } catch (err) {
    return { ok: false, message: (err instanceof Error ? err.message : String(err)).replace(/^settings: /, '') };
  }
}
