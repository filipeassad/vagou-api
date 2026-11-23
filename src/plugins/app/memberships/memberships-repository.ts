import createError from '@fastify/error';
import fp from 'fastify-plugin';
import type { Selectable } from 'kysely';
import type { Db } from '../../external/db.ts';
import type { Memberships } from '../../external/db-types.ts';
import { CondominiumNotFound, Forbidden } from '../authorization.ts';
import { normalizeEmail } from '../users/users-repository.ts';

export type Membership = Selectable<Memberships>;
export type MembershipRole = Membership['role'];
export type MembershipStatus = Membership['status'];

/** Vínculo com o condomínio e a unidade, como o próprio usuário vê em `GET /v1/me`. */
export type MembershipSummary = {
  id: string;
  role: MembershipRole;
  status: MembershipStatus;
  can_list_spots: boolean;
  unit_relation: Membership['unit_relation'];
  rejection_reason: string | null;
  condominium: { id: string; name: string; timezone: string };
  unit: { id: string; number: string; block: { id: string; name: string } } | null;
};

/** Vínculos de usuários com condomínios (plano 001, seção 3). */
export function createMembershipsRepository(db: Db) {
  return {
    /** O usuário é o acesso de portaria (aprovado) de algum condomínio? */
    async isFrontDesk(userId: string): Promise<boolean> {
      const row = await db
        .selectFrom('memberships')
        .select('id')
        .where('user_id', '=', userId)
        .where('role', '=', 'front_desk')
        .where('status', '=', 'approved')
        .executeTakeFirst();
      return row !== undefined;
    },

    /**
     * Vínculo atual (não removido) do usuário com o condomínio. Existe no máximo um
     * (índice único `memberships_one_active_per_user`).
     */
    findActive(userId: string, condominiumId: string): Promise<Membership | undefined> {
      return db
        .selectFrom('memberships')
        .selectAll()
        .where('user_id', '=', userId)
        .where('condominium_id', '=', condominiumId)
        .where('status', '<>', 'removed')
        .executeTakeFirst();
    },

    /** Vínculos atuais (não removidos) do usuário, do mais antigo ao mais novo. */
    async listForUser(userId: string): Promise<MembershipSummary[]> {
      const rows = await db
        .selectFrom('memberships as m')
        .innerJoin('condominiums as c', 'c.id', 'm.condominium_id')
        .leftJoin('units as u', 'u.id', 'm.unit_id')
        .leftJoin('blocks as b', 'b.id', 'u.block_id')
        .select([
          'm.id',
          'm.role',
          'm.status',
          'm.can_list_spots',
          'm.unit_relation',
          'm.rejection_reason',
          'c.id as condominium_id',
          'c.name as condominium_name',
          'c.timezone',
          'u.id as unit_id',
          'u.number as unit_number',
          'b.id as block_id',
          'b.name as block_name',
        ])
        .where('m.user_id', '=', userId)
        .where('m.status', '<>', 'removed')
        .orderBy('m.created_at')
        .execute();

      return rows.map((row) => ({
        id: row.id,
        role: row.role,
        status: row.status,
        can_list_spots: row.can_list_spots,
        unit_relation: row.unit_relation,
        rejection_reason: row.rejection_reason,
        condominium: { id: row.condominium_id, name: row.condominium_name, timezone: row.timezone },
        unit:
          row.unit_id && row.unit_number && row.block_id && row.block_name
            ? {
                id: row.unit_id,
                number: row.unit_number,
                block: { id: row.block_id, name: row.block_name },
              }
            : null,
      }));
    },

    /**
     * Passa o papel de síndico (req. 5), numa transação:
     * - o destino precisa ser morador aprovado do mesmo condomínio;
     * - o síndico atual vira morador da unidade dele. Sem unidade (cadastrado pelo admin
     *   antes de existirem unidades), não há como ser morador: o vínculo vira `removed`;
     * - o banco garante no máximo um síndico aprovado (`memberships_one_manager`).
     *
     * `actorUserId` (troca pelo síndico): conferido de novo dentro da trava, para quem
     * deixou de ser síndico numa troca simultânea não conseguir passar o papel.
     */
    async transferManager(
      condominiumId: string,
      target: { membershipId: string } | { email: string },
      actorUserId: string | null,
    ): Promise<ManagerTransfer> {
      return db.transaction().execute(async (trx) => {
        // Trava o condomínio: duas trocas simultâneas rodam uma depois da outra.
        const condominium = await trx
          .selectFrom('condominiums')
          .select(['id', 'name'])
          .where('id', '=', condominiumId)
          .forUpdate()
          .executeTakeFirst();
        if (!condominium) throw new CondominiumNotFound();

        const next = await trx
          .selectFrom('memberships as m')
          .innerJoin('users as u', 'u.id', 'm.user_id')
          .select(['m.id', 'm.role', 'm.status', 'u.id as user_id', 'u.name', 'u.email'])
          .where('m.condominium_id', '=', condominiumId)
          .where('m.status', '<>', 'removed')
          .where((eb) =>
            'membershipId' in target
              ? eb('m.id', '=', target.membershipId)
              : eb('u.email', '=', normalizeEmail(target.email)),
          )
          .executeTakeFirst();
        if (!next) throw new MembershipNotFound();
        if (next.role !== 'resident' || next.status !== 'approved') {
          throw new NotApprovedResident();
        }

        const current = await trx
          .selectFrom('memberships as m')
          .innerJoin('users as u', 'u.id', 'm.user_id')
          .select(['m.id', 'm.unit_id', 'm.unit_relation', 'u.id as user_id', 'u.name'])
          .where('m.condominium_id', '=', condominiumId)
          .where('m.role', '=', 'manager')
          .where('m.status', '=', 'approved')
          .executeTakeFirst();
        if (actorUserId !== null && current?.user_id !== actorUserId) throw new Forbidden();

        let previous: ManagerTransfer['previous_manager'] = null;
        if (current) {
          const becomesResident = current.unit_id !== null && current.unit_relation !== null;
          await trx
            .updateTable('memberships')
            .set(becomesResident ? { role: 'resident' } : { status: 'removed' })
            .where('id', '=', current.id)
            .execute();
          previous = {
            user_id: current.user_id,
            name: current.name,
            became: becomesResident ? 'resident' : 'removed',
          };
        }

        await trx
          .updateTable('memberships')
          .set({ role: 'manager' })
          .where('id', '=', next.id)
          .execute();

        return {
          condominium: { id: condominium.id, name: condominium.name },
          manager: { user_id: next.user_id, name: next.name, email: next.email },
          previous_manager: previous,
        };
      });
    },
  };
}

export const MembershipNotFound = createError(
  'MEMBERSHIP_NOT_FOUND',
  'Morador não encontrado neste condomínio.',
  404,
);

export const NotApprovedResident = createError(
  'NOT_APPROVED_RESIDENT',
  'O papel de síndico só pode ser passado para um morador aprovado do condomínio.',
  409,
);

export type ManagerTransfer = {
  condominium: { id: string; name: string };
  manager: { user_id: string; name: string; email: string };
  /** `resident`: continua como morador; `removed`: não tinha unidade e perdeu o vínculo. */
  previous_manager: { user_id: string; name: string; became: 'resident' | 'removed' } | null;
};

export type MembershipsRepository = ReturnType<typeof createMembershipsRepository>;

export default fp(
  async function membershipsRepositoryPlugin(fastify) {
    fastify.decorate('membershipsRepository', createMembershipsRepository(fastify.db));
  },
  { name: 'memberships-repository', dependencies: ['db'] },
);

declare module 'fastify' {
  interface FastifyInstance {
    membershipsRepository: MembershipsRepository;
  }
}
