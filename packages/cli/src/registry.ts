import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { AGENT_TRAFFIC_HEADER } from '@diffity/api';
import { get } from 'node:http';
import { isAbsolute, join } from 'node:path';
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

/**
 * Where all cross-repo state lives. The registry spans every repository, so it does not live in a
 * per-repo data directory — but it honors the same override, so an instance told to keep its data
 * elsewhere is findable under the same roof and a test never writes into the real one. Only an
 * absolute override counts: there is no repo root here to resolve a relative one against, and
 * cwd-relative registries would scatter one per directory.
 */
export function diffityDir(): string {
  const dir = process.env.DIFFITY_DATA_DIR?.trim();
  if (dir && !isAbsolute(dir)) {
    warnRelativeOverrideOnce(dir);
    return join(homedir(), '.diffity');
  }
  return dir || join(homedir(), '.diffity');
}

// Once: this runs on every registry touch, and the point is to surface the misconfiguration,
// not to narrate it.
let warnedRelativeOverride = false;

function warnRelativeOverrideOnce(dir: string): void {
  if (warnedRelativeOverride) {
    return;
  }
  warnedRelativeOverride = true;
  console.error(`diffity: ignoring relative DIFFITY_DATA_DIR "${dir}" for the registry; using ~/.diffity`);
}

function registryPath(): string {
  return join(diffityDir(), 'registry.json');
}

function lockPath(): string {
  return join(diffityDir(), 'registry.lock');
}

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

// /proc starttime is counted in USER_HZ ticks, which the kernel ABI fixes at 100.
const USER_HZ = 100;

/** When the pid began, or null where the platform will not say. */
function processStartedAtMs(pid: number): number | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      // Fields are counted past the parenthesised command name, which may itself hold
      // spaces and parentheses; starttime is the 20th after it.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const startTicks = Number(fields[19]);
      const btime = readFileSync('/proc/stat', 'utf-8')
        .split('\n')
        .find(line => line.startsWith('btime '));
      if (!btime || !Number.isFinite(startTicks)) {
        return null;
      }
      return Number(btime.split(' ')[1]) * 1000 + (startTicks / USER_HZ) * 1000;
    } catch {
      return null;
    }
  }
  try {
    const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      // %c output follows the locale, and a date Date.parse cannot read would void the guard.
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    const parsed = Date.parse(lstart);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Registration happens moments after the process starts, so a genuine entry's process always
// began before the entry was written. The slack absorbs tick arithmetic and clock jitter.
const PID_REUSE_SLACK_MS = 60_000;

/**
 * Pids get reused: an entry whose pid is alive may still be somebody else's process. One that
 * began after the entry was written cannot be the one that wrote it.
 */
export function entryIsAlive(entry: RegistryEntry): boolean {
  if (!isProcessAlive(entry.pid)) {
    return false;
  }
  const began = processStartedAtMs(entry.pid);
  const registered = Date.parse(entry.startedAt);
  if (began == null || !Number.isFinite(registered)) {
    return true;
  }
  return began <= registered + PID_REUSE_SLACK_MS;
}

/** Blocks without burning the cpu; the lock api is synchronous, so the waiting must be too. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(): void {
  mkdirSync(diffityDir(), { recursive: true });

  const start = Date.now();
  while (true) {
    try {
      writeFileSync(lockPath(), String(process.pid), { flag: 'wx' });
      return;
    } catch {
      // Lock file exists — check if stale
      try {
        const stat = statSync(lockPath());
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          try { unlinkSync(lockPath()); } catch {}
          continue;
        }
      } catch {
        // Lock disappeared between our check, retry
        continue;
      }

      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        // Force remove stale lock and try once more
        try { unlinkSync(lockPath()); } catch {}
        try {
          writeFileSync(lockPath(), String(process.pid), { flag: 'wx' });
          return;
        } catch {
          throw new Error('Could not acquire registry lock');
        }
      }

      sleepSync(50);
    }
  }
}

function releaseLock(): void {
  try { unlinkSync(lockPath()); } catch {}
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
  if (!existsSync(registryPath())) {
    return [];
  }
  try {
    return JSON.parse(readFileSync(registryPath(), 'utf-8'));
  } catch {
    return [];
  }
}

function writeRegistryRaw(entries: RegistryEntry[]): void {
  mkdirSync(diffityDir(), { recursive: true });
  writeFileSync(registryPath(), JSON.stringify(entries, null, 2));
}

function cleanStaleEntries(entries: RegistryEntry[]): RegistryEntry[] {
  return entries.filter((entry) => entryIsAlive(entry));
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

/**
 * What the server on a port says about itself: `serves` when /api/info names that repository root,
 * `other` when it names a different one, `silent` when nothing usable came back in time. Ports are
 * reused, and a registry that knows only its own data directory can hand a freed port to another
 * server — so an entry is trusted only once the server on its port has said whose it is.
 */
export function instanceServes(port: number, repoRoot: string): Promise<'serves' | 'other' | 'silent'> {
  return new Promise((resolve) => {
    const req = get(`http://localhost:${port}/api/info`, { headers: { [AGENT_TRAFFIC_HEADER]: '1' } }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        try {
          const root = (JSON.parse(body) as { root?: unknown }).root;
          resolve(res.statusCode !== 200 || typeof root !== 'string' ? 'silent' : root === repoRoot ? 'serves' : 'other');
        } catch {
          resolve('silent');
        }
      });
    });
    req.on('error', () => resolve('silent'));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve('silent');
    });
  });
}

/**
 * The registered server for a repository, if it is still that server: alive, and serving that root.
 * An entry that is certainly stale — its process gone, or its port answered for another repository —
 * is dropped from the registry so nothing else trusts it. One that is alive but did not answer is a
 * server that is busy, not gone: it is left registered and simply not reused this time.
 */
export async function findServingInstance(repoHash: string, repoRoot: string): Promise<RegistryEntry | null> {
  const entry = findInstanceForRepo(repoHash);
  if (!entry) {
    return null;
  }
  if (!entryIsAlive(entry)) {
    deregisterInstance(entry.pid);
    return null;
  }
  const answer = await instanceServes(entry.port, repoRoot);
  if (answer === 'other') {
    deregisterInstance(entry.pid);
  }
  return answer === 'serves' ? entry : null;
}

export function killInstance(entry: RegistryEntry): void {
  // A reused pid is somebody else's process; deregistering is all there is left to do.
  if (entryIsAlive(entry)) {
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {}
  }
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
