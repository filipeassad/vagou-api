import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helper.ts';

describe('plugin db', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('conecta no banco de teste', async () => {
    const { rows } = await sql<{ database: string }>`select current_database() as database`.execute(
      app.db,
    );

    expect(rows[0]?.database).toBe('vagou_test');
  });

  it('aplicou as migrações (extensões citext e btree_gist)', async () => {
    const { rows } = await sql<{ extname: string }>`
      select extname from pg_extension where extname in ('citext', 'btree_gist') order by extname
    `.execute(app.db);

    expect(rows.map((row) => row.extname)).toEqual(['btree_gist', 'citext']);
  });
});
