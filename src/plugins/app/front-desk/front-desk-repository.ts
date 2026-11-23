import createError from '@fastify/error';
import fp from 'fastify-plugin';
import { isUniqueViolation, type Db } from '../../external/db.ts';
import { normalizeEmail } from '../users/users-repository.ts';

/**
 * O e-mail já é de outra conta (morador, síndico, admin ou portaria de outro condomínio).
 * A portaria é um acesso próprio (req. 4): o síndico não pode definir a senha da conta
 * de outra pessoa.
 */
export const FrontDeskEmailInUse = createError(
  'FRONT_DESK_EMAIL_IN_USE',
  'Este e-mail já é usado por outra conta. Use um e-mail só para a portaria.',
  409,
);

export const FRONT_DESK_USER_NAME = 'Portaria';

export type FrontDeskAccess = { email: string };

/** Acesso da portaria: um usuário com vínculo `front_desk` por condomínio (req. 4; D12). */
export function createFrontDeskRepository(db: Db) {
  return {
    async find(condominiumId: string): Promise<FrontDeskAccess | null> {
      const row = await db
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select('u.email')
        .where('m.condominium_id', '=', condominiumId)
        .where('m.role', '=', 'front_desk')
        .where('m.status', '=', 'approved')
        .executeTakeFirst();
      return row ?? null;
    },

    /**
     * Cria ou redefine o acesso, numa transação:
     * - mesmo e-mail da portaria atual: troca a senha;
     * - e-mail novo: o vínculo da portaria anterior vira `removed` e o novo usuário entra.
     *   Um e-mail que já foi da portaria deste condomínio (e de nada mais) pode voltar;
     * - em todos os casos, as sessões da portaria (atual e anterior) são encerradas e
     *   links de redefinição pendentes deixam de valer.
     */
    async set(
      condominiumId: string,
      input: { email: string; passwordHash: string; decidedBy: string },
    ): Promise<FrontDeskAccess> {
      const email = normalizeEmail(input.email);
      return db.transaction().execute(async (trx) => {
        // Serializa trocas simultâneas da portaria do mesmo condomínio.
        await trx
          .selectFrom('condominiums')
          .select('id')
          .where('id', '=', condominiumId)
          .forUpdate()
          .executeTakeFirstOrThrow();

        const current = await trx
          .selectFrom('memberships')
          .select(['id', 'user_id'])
          .where('condominium_id', '=', condominiumId)
          .where('role', '=', 'front_desk')
          .where('status', '=', 'approved')
          .executeTakeFirst();

        const existing = await trx
          .selectFrom('users')
          .select(['id', 'is_admin'])
          .where('email', '=', email)
          .forUpdate()
          .executeTakeFirst();

        let userId: string;
        if (existing) {
          if (existing.id !== current?.user_id) {
            // Só reaproveita a conta se ela nunca foi nada além da portaria deste condomínio.
            const otherUse = await trx
              .selectFrom('memberships')
              .select('id')
              .where('user_id', '=', existing.id)
              .where((eb) =>
                eb.or([eb('condominium_id', '<>', condominiumId), eb('role', '<>', 'front_desk')]),
              )
              .executeTakeFirst();
            if (existing.is_admin || otherUse) throw new FrontDeskEmailInUse();
          }
          await trx
            .updateTable('users')
            .set({
              password_hash: input.passwordHash,
              failed_login_attempts: 0,
              locked_until: null,
            })
            .where('id', '=', existing.id)
            .execute();
          userId = existing.id;
        } else {
          try {
            const created = await trx
              .insertInto('users')
              .values({
                name: FRONT_DESK_USER_NAME,
                email,
                phone: null,
                password_hash: input.passwordHash,
              })
              .returning('id')
              .executeTakeFirstOrThrow();
            userId = created.id;
          } catch (err) {
            if (isUniqueViolation(err, 'users_email_key')) throw new FrontDeskEmailInUse();
            throw err;
          }
        }

        if (current?.user_id !== userId) {
          if (current) {
            await trx
              .updateTable('memberships')
              .set({ status: 'removed', decided_by: input.decidedBy, decided_at: new Date() })
              .where('id', '=', current.id)
              .execute();
          }
          await trx
            .insertInto('memberships')
            .values({
              user_id: userId,
              condominium_id: condominiumId,
              unit_id: null,
              role: 'front_desk',
              status: 'approved',
              origin: 'manager',
              decided_by: input.decidedBy,
              decided_at: new Date(),
            })
            .execute();
        }

        const affected = current ? [userId, current.user_id] : [userId];
        await trx
          .updateTable('sessions')
          .set({ revoked_at: new Date() })
          .where('user_id', 'in', affected)
          .where('revoked_at', 'is', null)
          .execute();
        await trx
          .updateTable('password_resets')
          .set({ used_at: new Date() })
          .where('user_id', 'in', affected)
          .where('used_at', 'is', null)
          .execute();

        return { email };
      });
    },
  };
}

export type FrontDeskRepository = ReturnType<typeof createFrontDeskRepository>;

export default fp(
  async function frontDeskRepositoryPlugin(fastify) {
    fastify.decorate('frontDeskRepository', createFrontDeskRepository(fastify.db));
  },
  { name: 'front-desk-repository', dependencies: ['db'] },
);

declare module 'fastify' {
  interface FastifyInstance {
    frontDeskRepository: FrontDeskRepository;
  }
}
