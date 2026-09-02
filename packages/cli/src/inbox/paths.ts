import { join } from 'node:path';
import { diffityDir } from '../registry.js';

/** Everything the inbox owns lives under one directory, beside the registry. */
export function inboxDir(): string {
  return join(diffityDir(), 'inbox');
}

export function inboxConfigPath(): string {
  return join(inboxDir(), 'config.json');
}

export function inboxStorePath(): string {
  return join(inboxDir(), 'inbox.sqlite');
}
