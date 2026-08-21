import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { execFileLarge } from './exec';

export interface TreeEntry {
  type: 'blob' | 'tree';
  path: string;
  name: string;
}

function getWorkingTreeFiles(dirPath?: string): string[] {
  const pathArgs = dirPath ? [dirPath + '/'] : [];

  const tracked = execFileLarge('git', ['ls-files', ...pathArgs]);

  const deleted = execFileLarge('git', ['ls-files', '--deleted', ...pathArgs]);

  const untracked = execFileLarge('git', [
    'ls-files',
    '--others',
    '--exclude-standard',
    ...pathArgs,
  ]);

  const deletedSet = new Set(deleted ? deleted.split('\n') : []);
  const files = new Set<string>();

  if (tracked) {
    for (const f of tracked.split('\n')) {
      if (!deletedSet.has(f)) {
        files.add(f);
      }
    }
  }
  if (untracked) {
    for (const f of untracked.split('\n')) {
      files.add(f);
    }
  }

  return Array.from(files).sort();
}

export function getTree(): string[] {
  return getWorkingTreeFiles();
}

export function getTreeEntries(_ref = 'HEAD', dirPath?: string): TreeEntry[] {
  const files = getWorkingTreeFiles(dirPath);
  const prefix = dirPath ? dirPath + '/' : '';
  const entries = new Map<string, TreeEntry>();

  for (const file of files) {
    const relative = file.slice(prefix.length);
    const slashIndex = relative.indexOf('/');
    if (slashIndex === -1) {
      entries.set(relative, { type: 'blob', path: file, name: relative });
    } else {
      const dirName = relative.slice(0, slashIndex);
      const fullPath = prefix + dirName;
      if (!entries.has(dirName)) {
        entries.set(dirName, { type: 'tree', path: fullPath, name: dirName });
      }
    }
  }

  return Array.from(entries.values());
}

export function getTreeFingerprint(): string {
  const tracked = execFileLarge('git', ['ls-files']);

  const statOutput = execFileLarge('git', ['status', '--porcelain', '-u']);

  return `${tracked.length}:${statOutput}`;
}

export function getWorkingTreeFileContent(filePath: string): string {
  const root = execFileLarge('git', ['rev-parse', '--show-toplevel']);
  return readFileSync(join(root, filePath), 'utf-8');
}

export function getWorkingTreeRawFile(filePath: string): { data: Buffer; fullPath: string } {
  const root = execFileLarge('git', ['rev-parse', '--show-toplevel']);
  const fullPath = join(root, filePath);
  return { data: readFileSync(fullPath), fullPath };
}
