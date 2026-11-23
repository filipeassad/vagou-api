import fp from 'fastify-plugin';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './db-types.ts';

/**
 * Tipos das tabelas, gerados a partir do banco em `db-types.ts` (`npm run db:codegen`
 * depois de cada migração). Nunca editar `db-types.ts` à mão.
 */
export type Database = DB;

export type Db = Kysely<Database>;

/** Cria a instância Kysely com um pool de conexões do driver `pg` (plano 001, D3). */
export function createDb(connectionString: string): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 10 }),
    }),
  });
}

/** Erro do Postgres por violar a constraint única `constraint` (código 23505). */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pgError = err as { code?: string; constraint?: string } | undefined;
  return pgError?.code === '23505' && pgError.constraint === constraint;
}

/** Erro do Postgres por violar uma chave estrangeira (código 23503). */
export function isForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === '23503';
}

/**
 * Conexão com o Postgres via Kysely. Expõe `fastify.db` para a aplicação toda e
 * fecha o pool quando a API desliga.
 */
export default fp(
  async function dbPlugin(fastify) {
    const db = createDb(fastify.config.DATABASE_URL);
    fastify.decorate('db', db);
    fastify.addHook('onClose', async () => {
      await db.destroy();
    });
  },
  { name: 'db' },
);

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
  }
}
