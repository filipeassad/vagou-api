import fp from 'fastify-plugin';
import { sql } from 'kysely';
import type { Db } from '../../external/db.ts';

/** Pedidos de redefinição de senha (spec 001, req. 21; plano 001, D10). */
export function createPasswordResetsRepository(db: Db) {
  return {
    /** Quando foi o último pedido do usuário (para não mandar e-mails em sequência). */
    async lastRequestedAt(userId: string): Promise<Date | undefined> {
      const row = await db
        .selectFrom('password_resets')
        .select((eb) => eb.fn.max('created_at').as('last'))
        .where('user_id', '=', userId)
        .executeTakeFirst();
      return row?.last ?? undefined;
    },

    /**
     * Registra um pedido novo. Os pedidos anteriores ainda não usados deixam de valer:
     * só o link do e-mail mais recente funciona.
     */
    async create(input: { userId: string; tokenHash: Buffer; ttlMinutes: number }) {
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('password_resets')
          .set({ used_at: sql`now()` })
          .where('user_id', '=', input.userId)
          .where('used_at', 'is', null)
          .execute();
        await trx
          .insertInto('password_resets')
          .values({
            user_id: input.userId,
            token_hash: input.tokenHash,
            expires_at: sql`now() + make_interval(mins => ${input.ttlMinutes})`,
          })
          .execute();
      });
    },

    /**
     * Troca a senha usando o token, numa transação: marca o token como usado (só se
     * ainda valer; duas requisições com o mesmo token → só uma vence), grava a senha
     * nova, desfaz o bloqueio de login e encerra todas as sessões do usuário.
     * Devolve o id do usuário, ou `undefined` se o token for inválido, usado ou vencido.
     */
    async resetPassword(tokenHash: Buffer, passwordHash: string): Promise<string | undefined> {
      return db.transaction().execute(async (trx) => {
        const reset = await trx
          .updateTable('password_resets')
          .set({ used_at: sql`now()` })
          .where('token_hash', '=', tokenHash)
          .where('used_at', 'is', null)
          .where('expires_at', '>', sql<Date>`now()`)
          .returning('user_id')
          .executeTakeFirst();
        if (!reset) return undefined;

        await trx
          .updateTable('users')
          .set({ password_hash: passwordHash, failed_login_attempts: 0, locked_until: null })
          .where('id', '=', reset.user_id)
          .execute();
        await trx
          .updateTable('sessions')
          .set({ revoked_at: sql`now()` })
          .where('user_id', '=', reset.user_id)
          .where('revoked_at', 'is', null)
          .execute();
        return reset.user_id;
      });
    },
  };
}

export type PasswordResetsRepository = ReturnType<typeof createPasswordResetsRepository>;

export default fp(
  async function passwordResetsRepositoryPlugin(fastify) {
    fastify.decorate('passwordResetsRepository', createPasswordResetsRepository(fastify.db));
  },
  { name: 'password-resets-repository', dependencies: ['db'] },
);

declare module 'fastify' {
  interface FastifyInstance {
    passwordResetsRepository: PasswordResetsRepository;
  }
}
