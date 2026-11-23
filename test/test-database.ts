import { sql } from 'kysely';
import type { Db } from '../src/plugins/external/db.ts';

/** Banco separado para os testes (plano 001, seção "Conexão com o banco"). */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? 'postgres://vagou:vagou@localhost:5433/vagou_test';

/**
 * Apaga os dados de todas as tabelas (menos as de controle das migrações).
 * Use em `beforeEach` nos testes que gravam no banco. Os arquivos de teste rodam
 * um por vez (vitest.config.ts) para um não apagar os dados do outro.
 */
export async function resetDatabase(db: Db) {
  const { rows } = await sql<{ tablename: string }>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename not like 'kysely_%'
  `.execute(db);
  if (rows.length === 0) return;
  const tables = sql.join(rows.map((row) => sql.table(row.tablename)));
  await sql`truncate ${tables} restart identity cascade`.execute(db);
}
