import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { MIGRATIONS, migrate, openDb, openPglite, openPostgres, pgPoolConfig, schemaVersion, type Db } from '../src/db.js';
import { removeDir, tempDir } from './helpers.js';

let db: Db | undefined;
let dir: string | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
  if (dir) {
    removeDir(dir);
    dir = undefined;
  }
});

describe('migrations', () => {
  it('creates every table once, and a reopened database applies nothing twice', async () => {
    dir = tempDir('db');
    const options = { databaseUrl: null, pgCa: null, dataDir: dir };
    db = await openDb(options);
    expect(await schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version);
    const tables = (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'"))
      .map(row => row.tablename);
    expect(tables).toEqual(expect.arrayContaining([
      'users', 'web_sessions', 'github_oauth_states', 'oauth_clients', 'oauth_codes', 'oauth_tokens',
      'repos', 'sessions', 'threads', 'comments', 'tours', 'tour_steps', 'schema_version',
    ]));
    await db.close();

    db = await openDb(options);
    await migrate(db);
    expect(await db.query('SELECT * FROM schema_version')).toHaveLength(MIGRATIONS.length);
  });

  it('applies migrations in version order, and a failing one leaves nothing of the batch behind', async () => {
    db = await openPglite();
    await migrate(db, [
      { version: 2, sql: 'ALTER TABLE t ADD COLUMN b TEXT' },
      { version: 1, sql: 'CREATE TABLE t (a TEXT)' },
    ]);
    expect(await schemaVersion(db)).toBe(2);

    await expect(migrate(db, [
      { version: 3, sql: 'CREATE TABLE u (x TEXT)' },
      { version: 4, sql: 'SELECT * FROM missing_table' },
    ])).rejects.toThrow('Migration 4 failed');
    expect(await schemaVersion(db)).toBe(2);
    expect(await db.query("SELECT tablename FROM pg_tables WHERE tablename = 'u'")).toEqual([]);
  });

  it('rolls a failed transaction back', async () => {
    db = await openPglite();
    await db.exec('CREATE TABLE t (a TEXT)');
    await expect(db.transaction(async tx => {
      await tx.query('INSERT INTO t VALUES ($1)', ['x']);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await db.query('SELECT * FROM t')).toEqual([]);
    expect(await db.one('SELECT * FROM t')).toBeUndefined();
  });

  it('reads a bigint as a number', async () => {
    db = await openPglite();
    expect(await db.one('SELECT $1::bigint AS n', [1_790_000_000_000])).toEqual({ n: 1_790_000_000_000 });
  });

  it('keeps a PGlite database under the data directory', async () => {
    dir = tempDir('db');
    db = await openPglite(join(dir, 'pg'));
    await db.exec("CREATE TABLE kept (a TEXT); INSERT INTO kept VALUES ('here')");
    await db.close();
    db = await openPglite(join(dir, 'pg'));
    expect(await db.query('SELECT a FROM kept')).toEqual([{ a: 'here' }]);
  });
});

describe('over the Postgres wire protocol', () => {
  it('migrates, reads bigints as numbers, and commits and rolls back transactions on one connection', async () => {
    const backing = await PGlite.create();
    const socket = new PGLiteSocketServer({ db: backing, port: 0, host: '127.0.0.1' });
    await socket.start();
    try {
      db = openPostgres({ connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres`, max: 1 });
      await migrate(db);
      expect(await schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version);
      expect(await db.one('SELECT $1::bigint AS n', [1_790_000_000_000])).toEqual({ n: 1_790_000_000_000 });
      await db.transaction(tx => tx.query("INSERT INTO repos (owner, name) VALUES ('a', 'b')"));
      await expect(db.transaction(async tx => {
        await tx.query("INSERT INTO repos (owner, name) VALUES ('c', 'd')");
        throw new Error('boom');
      })).rejects.toThrow('boom');
      expect(await db.query('SELECT owner FROM repos')).toEqual([{ owner: 'a' }]);
      await db.close();
      db = undefined;
    } finally {
      await socket.stop();
      await backing.close();
    }
  });
});

describe('pgPoolConfig', () => {
  const url = 'postgresql://diffity:p%40ss@10.0.0.3:5432/diffity?sslmode=verify-ca&sslrootcert=diffity-postgres-server-ca.pem';

  it('verifies the server against the given CA but not its host name, and drops the file-based parameters', () => {
    const config = pgPoolConfig(url, '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----');
    expect(config.connectionString).toBe('postgresql://diffity:p%40ss@10.0.0.3:5432/diffity');
    const ssl = config.ssl as { ca: string; rejectUnauthorized: boolean; checkServerIdentity: () => unknown };
    expect(ssl.ca).toContain('BEGIN CERTIFICATE');
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.checkServerIdentity()).toBeUndefined();
  });

  it('passes the URL through as it is without a CA', () => {
    expect(pgPoolConfig(url, null)).toEqual({ connectionString: url });
  });
});
