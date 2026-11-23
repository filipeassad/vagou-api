/**
 * Uso:
 *   npm run db:migrate    → aplica todas as migrações pendentes
 *   npm run db:rollback   → desfaz a última migração aplicada
 * Lê DATABASE_URL do ambiente (.env).
 */
import { createDb } from '../src/plugins/external/db.ts';
import { createMigrator } from './migrator.ts';

const command = process.argv[2];
if (command !== 'latest' && command !== 'down') {
  console.error('Uso: tsx scripts/migrate.ts <latest|down>');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL é obrigatória e não foi definida');
  process.exit(1);
}

const db = createDb(databaseUrl);
const migrator = createMigrator(db);

const { error, results } =
  command === 'latest' ? await migrator.migrateToLatest() : await migrator.migrateDown();

for (const result of results ?? []) {
  const action = result.direction === 'Up' ? 'aplicada' : 'desfeita';
  if (result.status === 'Success') console.log(`✔ ${result.migrationName} ${action}`);
  else if (result.status === 'Error') console.error(`✘ ${result.migrationName} falhou`);
}
if (!error && (results ?? []).length === 0) {
  console.log(
    command === 'latest' ? 'Nenhuma migração pendente.' : 'Nenhuma migração para desfazer.',
  );
}

await db.destroy();

if (error) {
  console.error(error);
  process.exit(1);
}
