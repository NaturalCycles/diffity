import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { MIGRATIONS, Store } from '../src/db.js';
import { removeDir, tempDir } from './helpers.js';

let dir: string;

afterEach(() => removeDir(dir));

describe('migrations', () => {
  it('creates every table once, and reopening applies nothing twice', () => {
    dir = tempDir('db');
    const path = join(dir, 'nested', 'diffity.db');
    const store = new Store(path);
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)!.version);
    const tables = store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(r => r.name);
    expect(tables).toEqual(expect.arrayContaining([
      'users', 'web_sessions', 'oauth_clients', 'oauth_codes', 'oauth_tokens',
      'repos', 'sessions', 'threads', 'comments', 'tours', 'tour_steps', 'schema_version',
    ]));
    store.close();

    const again = new Store(path);
    expect(again.all('SELECT * FROM schema_version')).toHaveLength(MIGRATIONS.length);
    again.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('applies later migrations in version order, and a failing one leaves nothing behind', () => {
    dir = tempDir('db');
    const path = join(dir, 'diffity.db');
    const store = new Store(path, [
      { version: 2, sql: 'ALTER TABLE t ADD COLUMN b TEXT' },
      { version: 1, sql: 'CREATE TABLE t (a TEXT)' },
    ]);
    expect(store.schemaVersion()).toBe(2);
    store.close();

    expect(() => new Store(path, [
      { version: 1, sql: 'CREATE TABLE t (a TEXT)' },
      { version: 2, sql: 'ALTER TABLE t ADD COLUMN b TEXT' },
      { version: 3, sql: 'CREATE TABLE u (x TEXT); SELECT * FROM missing_table' },
    ])).toThrow('Migration 3 failed');
    const reopened = new Store(path, []);
    expect(reopened.schemaVersion()).toBe(2);
    expect(reopened.all("SELECT name FROM sqlite_master WHERE name = 'u'")).toEqual([]);
    reopened.close();
  });

  it('rolls a failed transaction back', () => {
    dir = tempDir('db');
    const store = new Store(join(dir, 'diffity.db'), [{ version: 1, sql: 'CREATE TABLE t (a TEXT)' }]);
    expect(() => store.transaction(() => {
      store.run('INSERT INTO t VALUES (?)', 'x');
      throw new Error('boom');
    })).toThrow('boom');
    expect(store.all('SELECT * FROM t')).toEqual([]);
    store.close();
  });
});
