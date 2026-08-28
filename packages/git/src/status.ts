import { exec } from './exec.js';

export function isDirty(): boolean {
  return exec('git status --porcelain').length > 0;
}
