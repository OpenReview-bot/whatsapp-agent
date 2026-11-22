import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { migratePostgres, type PgClient } from '../src/persistence/postgres/migrate';
import { PostgresLearningStore } from '../src/persistence/postgres/learning-store';
import { resolveRuntimeDatastore } from '../src/persistence/postgres/runtime-selection';

// Real PostgreSQL engine (WASM) behind the same interfaces the app uses. Not Supabase, not Bun.SQL:
// it proves the SQL itself, not the network driver, pooling, roles or RLS.
function pgClient(db: PGlite): PgClient {
  return {
    begin: (cb) => db.transaction((tx) => cb({ unsafe: async (s, p) => (await tx.query(s, p as unknown[])).rows as Record<string, unknown>[] }))
  };
}
function bunSqlShim(db: PGlite) {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '');
    return db.query(text, values).then((r) => r.rows);
  }) as never;
}
const m002 = () => readFileSync(new URL('../src/persistence/postgres/migrations/002_learning_memory.sql', import.meta.url), 'utf8');

describe('PostgreSQL schema on a real Postgres engine (PGlite)', () => {
  test('001 migration applies, is idempotent, and refuses a newer schema', async () => {
    const db = new PGlite();
    expect((await migratePostgres(pgClient(db))).applied).toBe(true);
    expect((await migratePostgres(pgClient(db))).applied).toBe(false);
    await db.query('INSERT INTO wa_agent.schema_migrations(version, applied_at) VALUES (99, 1)');
    await expect(migratePostgres(pgClient(db))).rejects.toThrow('newer');
  });

  test('KNOWN GAP: the migrator does not create the learning tables from 002', async () => {
    const db = new PGlite();
    await migratePostgres(pgClient(db));
    const r = await db.query(`SELECT to_regclass('wa_agent.learning_states') AS t`);
    expect((r.rows[0] as { t: unknown }).t).toBeNull();
  });

  test('learning store round-trips on the 002 schema', async () => {
    const db = new PGlite();
    await migratePostgres(pgClient(db));
    await db.exec(m002());
    const store = new PostgresLearningStore({ sql: bunSqlShim(db) });
    await store.saveLearningState('b1', 'workbook', 'v1 مرحبا');
    await store.saveLearningState('b1', 'workbook', 'v2');
    const s = await store.getLearningState('b1', 'workbook');
    expect(s?.content).toBe('v2');
    expect(s?.version).toBe(2);
    expect(await store.getLearningState('b1', 'notebook')).toBeUndefined();
    await store.saveReflectionRun({ brandId: 'b1', chatId: 'c1', triggerReason: 'test', inputMessageCount: 3 });
    expect((await store.getReflectionRuns('c1')).length).toBe(1);
    await store.updateThreadActivity('b1', 'c1', 1000);
    expect(await store.getColdThreads('b1', 1, 5)).toContain('c1');
    await store.markThreadReflected('b1', 'c1', 2000);
  });

  test('runtime cutover stays closed', () => {
    expect(() => resolveRuntimeDatastore({ DATASTORE: 'postgres', DATABASE_URL: 'postgres://x' })).toThrow('not yet available');
  });
});
