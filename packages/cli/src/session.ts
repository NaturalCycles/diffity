import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getHeadHash, getDiffityDir } from '@diffity/git';
import { getDb, queryOne } from './db.js';

export interface Session {
  id: string;
  ref: string;
  headHash: string;
}

function sessionFilePath(): string {
  return join(getDiffityDir(), 'current-session');
}

export function findOrCreateSession(ref: string): Session {
  const db = getDb();
  const headHash = getHeadHash();

  const existing = queryOne<{ id: string; ref: string; head_hash: string }>(
    'SELECT id, ref, head_hash FROM review_sessions WHERE ref = ? AND head_hash = ?',
    ref,
    headHash,
  );

  if (existing) {
    const session: Session = { id: existing.id, ref: existing.ref, headHash: existing.head_hash };
    writeFileSync(sessionFilePath(), JSON.stringify(session));
    return session;
  }

  const id = randomUUID();
  db.prepare(
    'INSERT INTO review_sessions (id, ref, head_hash) VALUES (?, ?, ?)'
  ).run(id, ref, headHash);

  const session: Session = { id, ref, headHash };
  writeFileSync(sessionFilePath(), JSON.stringify(session));
  return session;
}

export function getCurrentSession(): Session | null {
  try {
    const raw = readFileSync(sessionFilePath(), 'utf-8');
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}
