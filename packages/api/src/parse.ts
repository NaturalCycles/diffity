import { AUTHOR_TYPES, type CommentAuthor } from './threads.js';

/**
 * What a parser answers: the typed value, or what is wrong with the input. Parsing happens at a
 * boundary — a request body, a bundle file — so the message is written for whoever sent it.
 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

// Hand-rolled rather than a schema library: the wire has one small shape per route, and a field
// reader that throws keeps each parser a flat object literal.

export class FieldError extends Error {}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FieldError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseWith<T>(
  body: unknown,
  build: (obj: Record<string, unknown>) => T,
  rootLabel = 'Request body',
): ParseResult<T> {
  try {
    return { ok: true, value: build(record(body, rootLabel)) };
  } catch (error) {
    if (error instanceof FieldError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

export function str(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new FieldError(`${label} must be a non-empty string`);
  }
  return value;
}

/** For the few fields where empty means something, like the editor path that means the repo root. */
export function anyStr(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new FieldError(`${label} must be a string`);
  }
  return value;
}

export function optStr(value: unknown, label: string): string | undefined {
  return value == null ? undefined : anyStr(value, label);
}

export function int(value: unknown, label: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new FieldError(`${label} must be an integer >= ${min}`);
  }
  return value;
}

export function optInt(value: unknown, label: string, min: number): number | undefined {
  return value == null ? undefined : int(value, label, min);
}

export function optBool(value: unknown, label: string): boolean | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new FieldError(`${label} must be a boolean`);
  }
  return value;
}

export function member<T extends string>(value: unknown, label: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new FieldError(`${label} must be one of: ${values.join(', ')}`);
  }
  return value as T;
}

export function optMember<T extends string>(
  value: unknown,
  label: string,
  values: readonly T[],
): T | undefined {
  return value == null ? undefined : member(value, label, values);
}

export function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new FieldError(`${label} must be an array`);
  }
  return value;
}

/**
 * Normalised to `toISOString()` form, so stored timestamps sort as time regardless of who wrote
 * them. A zone is required: without one, `Date.parse` answers in the reader's zone, and the same
 * bundle would import with different times on different machines.
 */
export function timestamp(value: unknown, label: string): string {
  const raw = str(value, label);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    throw new FieldError(`${label} must be an ISO 8601 timestamp with a time zone`);
  }
  return new Date(ms).toISOString();
}

export function lineRange(obj: Record<string, unknown>, min: number, label = ''): { startLine: number; endLine: number } {
  const prefix = label ? `${label}.` : '';
  const startLine = int(obj.startLine, `${prefix}startLine`, min);
  const endLine = int(obj.endLine, `${prefix}endLine`, min);
  if (endLine < startLine) {
    throw new FieldError(`${prefix}endLine must not be before ${prefix}startLine`);
  }
  return { startLine, endLine };
}

/** Built from the fields it names, so nothing else in the input object reaches storage. */
export function author(value: unknown, label: string): CommentAuthor {
  const obj = record(value, label);
  return {
    name: str(obj.name, `${label}.name`),
    type: member(obj.type, `${label}.type`, AUTHOR_TYPES),
    avatarUrl: optStr(obj.avatarUrl, `${label}.avatarUrl`),
  };
}
