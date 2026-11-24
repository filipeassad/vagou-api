import createError from '@fastify/error';
import fp from 'fastify-plugin';
import type { Db } from '../../external/db.ts';
import type { Events } from '../events.ts';
import { UnitNotFound } from '../condominiums/units-repository.ts';
import { Forbidden } from '../authorization.ts';
import { MembershipNotFound, type MembershipStatus } from './memberships-repository.ts';

/** Ex.: aprovar quem já foi aprovado ou recusado (recusado precisa reenviar antes). */
export const InvalidMembershipStatus = createError(
  'INVALID_MEMBERSHIP_STATUS',
  'Este cadastro não está aguardando aprovação.',
  409,
);

/** Req. 3 e 17: com a regra do condomínio desligada, inquilino não pode anunciar. */
export const TenantsCannotListSpots = createError(
  'TENANTS_CANNOT_LIST_SPOTS',
  'Este condomínio não permite que inquilinos anunciem vagas.',
  409,
);

/** Req. 24: o síndico não remove a si mesmo; antes, passa o papel (T15). */
export const CannotRemoveManager = createError(
  'CANNOT_REMOVE_MANAGER',
  'Para remover o síndico, transfira o papel de síndico para outro morador antes.',
  409,
);

/** T23: síndico sem unidade precisa informar as duas coisas. */
export const ManagerUnitRequired = createError(
  'MANAGER_UNIT_REQUIRED',
  'Informe a sua unidade e se você é proprietário ou inquilino.',
  400,
);

export type Relation = 'owner' | 'tenant';

export type ResidentListItem = {
  id: string;
  role: 'resident' | 'manager';
  status: Exclude<MembershipStatus, 'removed'>;
  unit_relation: Relation | null;
  can_list_spots: boolean;
  rejection_reason: string | null;
  created_at: Date;
  decided_at: Date | null;
  user: { id: string; name: string; email: string; phone: string | null };
  unit: { id: string; number: string; block: { id: string; name: string } } | null;
};

/** Para o aviso ao morador. */
export type Decided = {
  membershipId: string;
  user: { id: string; name: string; email: string };
  condominium: { id: string; name: string };
};

/**
 * Aprovação e permissões dos moradores pelo síndico (spec 001, req. 15–19). Toda função
 * filtra por `condominiumId` (princípio I). Mudanças de situação são UPDATEs condicionais
 * (`where status = ...`): duas decisões simultâneas não passam as duas.
 */
export function createReviewsRepository(db: Db, events: Events) {
  /** Trava a linha do condomínio em modo compartilhado: a regra de inquilinos não muda no meio. */
  async function tenantsCanListSpots(trx: Db, condominiumId: string) {
    const condominium = await trx
      .selectFrom('condominiums')
      .select(['name', 'tenants_can_list_spots'])
      .where('id', '=', condominiumId)
      .forShare()
      .executeTakeFirstOrThrow();
    return condominium;
  }

  async function findOne(trx: Db, condominiumId: string, membershipId: string) {
    const row = await trx
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['m.id', 'm.role', 'm.status', 'm.unit_relation'])
      .select(['u.id as user_id', 'u.name', 'u.email'])
      .where('m.condominium_id', '=', condominiumId)
      .where('m.id', '=', membershipId)
      .where('m.status', '<>', 'removed')
      .where('m.role', '<>', 'front_desk')
      .forUpdate('m')
      .executeTakeFirst();
    if (!row) throw new MembershipNotFound();
    return row;
  }

  function assertTenantRule(
    relation: Relation | null,
    canListSpots: boolean,
    tenantsAllowed: boolean,
  ) {
    if (canListSpots && relation === 'tenant' && !tenantsAllowed) {
      throw new TenantsCannotListSpots();
    }
  }

  return {
    /** Moradores e síndico (a portaria fica de fora), do mais novo ao mais antigo. */
    async list(
      condominiumId: string,
      status?: Exclude<MembershipStatus, 'removed'>,
    ): Promise<ResidentListItem[]> {
      const rows = await db
        .selectFrom('memberships as m')
        .innerJoin('users as usr', 'usr.id', 'm.user_id')
        .leftJoin('units as u', 'u.id', 'm.unit_id')
        .leftJoin('blocks as b', 'b.id', 'u.block_id')
        .select([
          'm.id',
          'm.role',
          'm.status',
          'm.unit_relation',
          'm.can_list_spots',
          'm.rejection_reason',
          'm.created_at',
          'm.decided_at',
          'usr.id as user_id',
          'usr.name',
          'usr.email',
          'usr.phone',
          'u.id as unit_id',
          'u.number as unit_number',
          'b.id as block_id',
          'b.name as block_name',
        ])
        .where('m.condominium_id', '=', condominiumId)
        .where('m.role', 'in', ['resident', 'manager'])
        .where('m.status', '<>', 'removed')
        .$if(status !== undefined, (qb) => qb.where('m.status', '=', status!))
        .orderBy('m.created_at', 'desc')
        .execute();

      return rows.map((row) => ({
        id: row.id,
        role: row.role as ResidentListItem['role'],
        status: row.status as ResidentListItem['status'],
        unit_relation: row.unit_relation,
        can_list_spots: row.can_list_spots,
        rejection_reason: row.rejection_reason,
        created_at: row.created_at,
        decided_at: row.decided_at,
        user: { id: row.user_id, name: row.name, email: row.email, phone: row.phone },
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

    /** Pendente → aprovado, definindo se pode anunciar (req. 16, 17). */
    async approve(
      condominiumId: string,
      membershipId: string,
      input: { canListSpots: boolean; decidedBy: string },
    ): Promise<Decided> {
      return db.transaction().execute(async (trx) => {
        const condominium = await tenantsCanListSpots(trx, condominiumId);
        const membership = await findOne(trx, condominiumId, membershipId);
        if (membership.status !== 'pending') throw new InvalidMembershipStatus();
        assertTenantRule(
          membership.unit_relation,
          input.canListSpots,
          condominium.tenants_can_list_spots,
        );

        await trx
          .updateTable('memberships')
          .set({
            status: 'approved',
            can_list_spots: input.canListSpots,
            rejection_reason: null,
            decided_by: input.decidedBy,
            decided_at: new Date(),
          })
          .where('id', '=', membershipId)
          .where('status', '=', 'pending')
          .execute();

        return {
          membershipId,
          user: { id: membership.user_id, name: membership.name, email: membership.email },
          condominium: { id: condominiumId, name: condominium.name },
        };
      });
    },

    /** Pendente → recusado, com motivo opcional (req. 18). */
    async reject(
      condominiumId: string,
      membershipId: string,
      input: { reason: string | null; decidedBy: string },
    ): Promise<Decided> {
      return db.transaction().execute(async (trx) => {
        const condominium = await tenantsCanListSpots(trx, condominiumId);
        const membership = await findOne(trx, condominiumId, membershipId);
        if (membership.status !== 'pending') throw new InvalidMembershipStatus();

        await trx
          .updateTable('memberships')
          .set({
            status: 'rejected',
            can_list_spots: false,
            rejection_reason: input.reason,
            decided_by: input.decidedBy,
            decided_at: new Date(),
          })
          .where('id', '=', membershipId)
          .execute();

        return {
          membershipId,
          user: { id: membership.user_id, name: membership.name, email: membership.email },
          condominium: { id: condominiumId, name: condominium.name },
        };
      });
    },

    /** Liga/desliga a permissão de anunciar de um morador aprovado (req. 17). */
    async setCanListSpots(condominiumId: string, membershipId: string, canListSpots: boolean) {
      return db.transaction().execute(async (trx) => {
        const condominium = await tenantsCanListSpots(trx, condominiumId);
        const membership = await findOne(trx, condominiumId, membershipId);
        if (membership.status !== 'approved') throw new InvalidMembershipStatus();
        assertTenantRule(
          membership.unit_relation,
          canListSpots,
          condominium.tenants_can_list_spots,
        );

        await trx
          .updateTable('memberships')
          .set({ can_list_spots: canListSpots })
          .where('id', '=', membershipId)
          .execute();
      });
    },

    /**
     * Remoção pelo síndico (req. 24, 25): qualquer situação (pendente, aprovado, recusado).
     * Numa transação só:
     * - trava o condomínio, como a troca de síndico (T15): o morador não é promovido a
     *   síndico e removido ao mesmo tempo;
     * - vínculo vira `removed` e perde a permissão de anunciar. O acesso ao condomínio
     *   acaba no próximo request, porque o vínculo é conferido a cada requisição (D8);
     * - se o usuário não tiver mais nenhum vínculo ativo (nem for admin), encerra as
     *   sessões dele: a conta deixa de servir para algo. Com vínculo em outro condomínio,
     *   as sessões ficam, para não derrubá-lo lá (princípio I);
     * - emite `membership.removed`: se um handler falhar, nada disso é gravado.
     */
    async remove(condominiumId: string, membershipId: string, removedBy: string) {
      await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('condominiums')
          .select('id')
          .where('id', '=', condominiumId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const membership = await findOne(trx, condominiumId, membershipId);
        if (membership.role !== 'resident') throw new CannotRemoveManager();

        await trx
          .updateTable('memberships')
          .set({
            status: 'removed',
            can_list_spots: false,
            decided_by: removedBy,
            decided_at: new Date(),
          })
          .where('id', '=', membershipId)
          .execute();

        const stillUsed = await trx
          .selectFrom('users as u')
          .select('u.id')
          .where('u.id', '=', membership.user_id)
          .where((eb) =>
            eb.or([
              eb('u.is_admin', '=', true),
              eb.exists(
                eb
                  .selectFrom('memberships as m')
                  .select('m.id')
                  .whereRef('m.user_id', '=', 'u.id')
                  .where('m.status', '<>', 'removed'),
              ),
            ]),
          )
          .executeTakeFirst();
        if (!stillUsed) {
          await trx
            .updateTable('sessions')
            .set({ revoked_at: new Date() })
            .where('user_id', '=', membership.user_id)
            .where('revoked_at', 'is', null)
            .execute();
        }

        await events.emit(
          'membership.removed',
          { condominiumId, membershipId, userId: membership.user_id, removedBy },
          trx,
        );
      });
    },

    /**
     * O síndico informa a própria unidade (req. 5; plano, item 10 da seção 9, opção (b)).
     * Continua síndico aprovado, sem aviso a ninguém. Serve para, ao passar o papel, ele
     * virar morador aprovado dessa unidade em vez de sair do condomínio.
     * - Trava o condomínio em modo compartilhado: não roda junto com a troca de síndico
     *   (que trava em modo exclusivo) nem com a mudança da regra de inquilinos.
     * - Inquilino com a regra desligada perde a permissão de anunciar (req. 3).
     */
    async setManagerUnit(
      condominiumId: string,
      membershipId: string,
      patch: { unitId?: string; unitRelation?: Relation },
    ) {
      await db.transaction().execute(async (trx) => {
        const condominium = await tenantsCanListSpots(trx, condominiumId);
        const current = await trx
          .selectFrom('memberships')
          .select(['unit_id', 'unit_relation', 'can_list_spots'])
          .where('condominium_id', '=', condominiumId)
          .where('id', '=', membershipId)
          .where('role', '=', 'manager')
          .where('status', '=', 'approved')
          .forUpdate()
          .executeTakeFirst();
        // Deixou de ser síndico numa troca que terminou antes desta.
        if (!current) throw new Forbidden();

        const unitId = patch.unitId ?? current.unit_id;
        const unitRelation = patch.unitRelation ?? current.unit_relation;
        if (!unitId || !unitRelation) throw new ManagerUnitRequired();

        const unit = await trx
          .selectFrom('units')
          .select('id')
          .where('condominium_id', '=', condominiumId)
          .where('id', '=', unitId)
          .executeTakeFirst();
        if (!unit) throw new UnitNotFound();

        const loses = unitRelation === 'tenant' && !condominium.tenants_can_list_spots;
        await trx
          .updateTable('memberships')
          .set({
            unit_id: unitId,
            unit_relation: unitRelation,
            ...(loses && { can_list_spots: false }),
          })
          .where('id', '=', membershipId)
          .execute();
      });
    },

    /**
     * O próprio morador corrige unidade/vínculo e reenvia (req. 18): recusado ou pendente
     * volta a pendente, sem o motivo da recusa. A unidade precisa ser deste condomínio.
     */
    async resubmit(
      condominiumId: string,
      membershipId: string,
      patch: { unitId?: string; unitRelation?: Relation },
    ): Promise<{ unitLabel: string }> {
      return db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom('memberships')
          .select(['unit_id', 'status'])
          .where('condominium_id', '=', condominiumId)
          .where('id', '=', membershipId)
          .forUpdate()
          .executeTakeFirst();
        if (!current) throw new MembershipNotFound();
        if (current.status !== 'pending' && current.status !== 'rejected') {
          throw new InvalidMembershipStatus();
        }

        const unit = await trx
          .selectFrom('units as u')
          .innerJoin('blocks as b', 'b.id', 'u.block_id')
          .select(['u.number', 'b.name as block_name'])
          .where('u.condominium_id', '=', condominiumId)
          .where('u.id', '=', patch.unitId ?? current.unit_id!)
          .executeTakeFirst();
        if (!unit) throw new UnitNotFound();

        await trx
          .updateTable('memberships')
          .set({
            ...(patch.unitId !== undefined && { unit_id: patch.unitId }),
            ...(patch.unitRelation !== undefined && { unit_relation: patch.unitRelation }),
            status: 'pending',
            rejection_reason: null,
            can_list_spots: false,
            decided_by: null,
            decided_at: null,
          })
          .where('id', '=', membershipId)
          .execute();

        return { unitLabel: `${unit.block_name}, unidade ${unit.number}` };
      });
    },
  };
}

export type ReviewsRepository = ReturnType<typeof createReviewsRepository>;

export default fp(
  async function reviewsRepositoryPlugin(fastify) {
    fastify.decorate('reviewsRepository', createReviewsRepository(fastify.db, fastify.events));
  },
  { name: 'reviews-repository', dependencies: ['db', 'events'] },
);

declare module 'fastify' {
  interface FastifyInstance {
    reviewsRepository: ReviewsRepository;
  }
}
