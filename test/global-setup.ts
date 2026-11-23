import pg from 'pg';
import { createDb } from '../src/plugins/external/db.ts';
import { createMigrator } from '../scripts/migrator.ts';
import { TEST_DATABASE_URL } from './test-database.ts';

/**
 * Roda uma vez antes da suíte: cria o banco de teste (se não existir) e aplica
 * todas as migrações. Exige o Postgres local rodando (`npm run db:up`).
 */
export default async function setup() {
  await ensureDatabaseExists(TEST_DATABASE_URL);

  const db = createDb(TEST_DATABASE_URL);
  const { error } = await createMigrator(db).migrateToLatest();
  await db.destroy();
  if (error) throw error;
}

async function ensureDatabaseExists(url: string) {
  const target = new URL(url);
  const databaseName = decodeURIComponent(target.pathname.slice(1));
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';

  const client = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Não foi possível conectar ao Postgres de teste (${target.host}). ` +
        'Ele está rodando? Use `npm run db:up`.',
      { cause: err },
    );
  }
  try {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [
      databaseName,
    ]);
    if (!rowCount) {
      await client.query(`create database "${databaseName.replaceAll('"', '""')}"`);
    }
  } finally {
    await client.end();
  }
}
