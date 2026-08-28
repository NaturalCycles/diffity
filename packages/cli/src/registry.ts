import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { AGENT_TRAFFIC_HEADER } from '@diffity/api';
import { get } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface RegistryEntry {
  pid: number;
  port: number;
  repoRoot: string;
  repoHash: string;
  repoName: string;
  ref: string;
  description: string;
  startedAt: string;
  version?: string;
}

const DIFFITY_DIR = join(homedir(), '.diffity');
const REGISTRY_PATH = join(DIFFITY_DIR, 'registry.json');
const LOCK_PATH = join(DIFFITY_DIR, 'registry.lock');
const LOCK_STALE_MS = 5000;
const LOCK_TIMEOUT_MS = 3000;
const BASE_PORT = 5391;
const MAX_PORT_ATTEMPTS = 10;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): void {
  mkdirSync(DIFFITY_DIR, { recursive: true });

  const start = Date.now();
  while (true) {
    try {
      writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
      return;
    } catch {
      // Lock file exists — check if stale
      try {
        const stat = statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          try { unlinkSync(LOCK_PATH); } catch {}
          continue;
        }
      } catch {
        // Lock disappeared between our check, retry
        continue;
      }

      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        // Force remove stale lock and try once more
        try { unlinkSync(LOCK_PATH); } catch {}
        try {
          writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
          return;
        } catch {
          throw new Error('Could not acquire registry lock');
        }
      }

      // Brief busy-wait
      const wait = Date.now() + 50;
      while (Date.now() < wait) {}
    }
  }
}

function releaseLock(): void {
  try { unlinkSync(LOCK_PATH); } catch {}
}

function withLock<T>(fn: () => T): T {
  acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

function readRegistryRaw(): RegistryEntry[] {
  if (!existsSync(REGISTRY_PATH)) {
    return [];
  }
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function writeRegistryRaw(entries: RegistryEntry[]): void {
  mkdirSync(DIFFITY_DIR, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2));
}

function cleanStaleEntries(entries: RegistryEntry[]): RegistryEntry[] {
  return entries.filter((entry) => isProcessAlive(entry.pid));
}

export function readRegistry(): RegistryEntry[] {
  return withLock(() => {
    const entries = readRegistryRaw();
    const clean = cleanStaleEntries(entries);
    if (clean.length !== entries.length) {
      writeRegistryRaw(clean);
    }
    return clean;
  });
}

export function registerInstance(entry: RegistryEntry): void {
  withLock(() => {
    const entries = cleanStaleEntries(readRegistryRaw());
    // Remove any existing entry for same PID (shouldn't happen, but be safe)
    const filtered = entries.filter((e) => e.pid !== entry.pid);
    filtered.push(entry);
    writeRegistryRaw(filtered);
  });
}

export function deregisterInstance(pid: number): void {
  withLock(() => {
    const entries = readRegistryRaw();
    const filtered = entries.filter((e) => e.pid !== pid);
    writeRegistryRaw(filtered);
  });
}

export function findInstanceForRepo(repoHash: string): RegistryEntry | null {
  const entries = readRegistry();
  const match = entries.find((e) => e.repoHash === repoHash);
  if (!match) {
    return null;
  }
  return match;
}

export function checkInstanceHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // Says who it is: a reader's info polls steer which session the agent follows, and this is not one.
    const req = get(`http://localhost:${port}/api/info`, { headers: { [AGENT_TRAFFIC_HEADER]: '1' } }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

export function killInstance(entry: RegistryEntry): void {
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch {}
  deregisterInstance(entry.pid);
}

export function findAvailablePort(): number {
  const entries = readRegistry();
  const usedPorts = new Set(entries.map((e) => e.port));
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const candidate = BASE_PORT + i;
    if (!usedPorts.has(candidate)) {
      return candidate;
    }
  }
  // Fall back to letting the OS assign
  return 0;
}
