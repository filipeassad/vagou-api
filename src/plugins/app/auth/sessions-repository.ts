import fp from 'fastify-plugin';
import type { Selectable } from 'kysely';
import type { Db } from '../../external/db.ts';
import type { Sessions } from '../../external/db-types.ts';

export type NewSession = {
  userId: string;
  refreshTokenHash: Buffer;
  expiresAt: Date;
  userAgent: string | null;
};

export type Session = Selectable<Sessions>;

/** Sessões de login: uma por aparelho, identificada pelo refresh token (plano 001, D5). */
export function createSessionsRepository(db: Db) {
  function insert(executor: Db, input: NewSession) {
    return executor
      .insertInto('sessions')
      .values({
        user_id: input.userId,
        refresh_token_hash: input.refreshTokenHash,
        expires_at: input.expiresAt,
        user_agent: input.userAgent?.slice(0, 500) ?? null,
      })
      .returning(['id', 'user_id', 'expires_at'])
      .executeTakeFirstOrThrow();
  }

  return {
    create(input: NewSession) {
      return insert(db, input);
    },

    findByRefreshTokenHash(hash: Buffer): Promise<Session | undefined> {
      return db
        .selectFrom('sessions')
        .selectAll()
        .where('refresh_token_hash', '=', hash)
        .executeTakeFirst();
    },

    /**
     * Rotação: cria a sessão nova e encerra a antiga apontando para ela (`replaced_by`),
     * numa transação. O UPDATE só vale se a antiga ainda estiver ativa: se duas
     * requisições tentarem rotacionar o mesmo token ao mesmo tempo, só uma vence e a
     * outra recebe `undefined`.
     */
    async rotate(oldSessionId: string, next: NewSession) {
      return db.transaction().execute(async (trx) => {
        const created = await insert(trx, next);
        const updated = await trx
          .updateTable('sessions')
          .set({ revoked_at: new Date(), replaced_by: created.id, last_used_at: new Date() })
          .where('id', '=', oldSessionId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        if (updated.numUpdatedRows === 0n) {
          throw new SessionAlreadyRotated();
        }
        return created;
      });
    },

    async revoke(sessionId: string): Promise<void> {
      await db
        .updateTable('sessions')
        .set({ revoked_at: new Date() })
        .where('id', '=', sessionId)
        .where('revoked_at', 'is', null)
        .execute();
    },

    /**
     * Sessão do access token ainda vale? Conferido a cada requisição autenticada (D5):
     * logout, troca de senha e reuso de refresh cortam o acesso na hora, sem esperar
     * os 15 min do JWT. Devolve o usuário dono para não precisar de outra consulta.
     */
    findActiveWithUser(sessionId: string, userId: string) {
      return db
        .selectFrom('sessions')
        .innerJoin('users', 'users.id', 'sessions.user_id')
        .select(['sessions.id as session_id', 'users.id as user_id', 'users.is_admin'])
        .where('sessions.id', '=', sessionId)
        .where('sessions.user_id', '=', userId)
        .where('sessions.revoked_at', 'is', null)
        .where('sessions.expires_at', '>', new Date())
        .executeTakeFirst();
    },

    /** Encerra todas as sessões ativas do usuário (reuso de token, troca de senha, remoção). */
    async revokeAllForUser(userId: string): Promise<number> {
      const result = await db
        .updateTable('sessions')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
  };
}

/** Uso interno: outra requisição rotacionou a mesma sessão primeiro (desfaz a transação). */
export class SessionAlreadyRotated extends Error {
  constructor() {
    super('Sessão já rotacionada por outra requisição');
    this.name = 'SessionAlreadyRotated';
  }
}

export type SessionsRepository = ReturnType<typeof createSessionsRepository>;

export default fp(
  async function sessionsRepositoryPlugin(fastify) {
    fastify.decorate('sessionsRepository', createSessionsRepository(fastify.db));
  },
  { name: 'sessions-repository', dependencies: ['db'] },
);

declare module 'fastify' {
  interface FastifyInstance {
    sessionsRepository: SessionsRepository;
  }
}
