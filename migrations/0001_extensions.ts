import { sql, type Kysely } from 'kysely';

// citext: e-mail sem diferenciar maiúsculas/minúsculas (plano 001, req. 23).
// btree_gist: necessária para a constraint que impede reservas sobrepostas (plano 002, princípio IV).
export async function up(db: Kysely<any>): Promise<void> {
  await sql`create extension if not exists citext`.execute(db);
  await sql`create extension if not exists btree_gist`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop extension if exists btree_gist`.execute(db);
  await sql`drop extension if exists citext`.execute(db);
}
