import createError from '@fastify/error';
import fp from 'fastify-plugin';
import { sql } from 'kysely';
import { isUniqueViolation, type Db } from '../../external/db.ts';
import { UnitNotFound } from '../condominiums/units-repository.ts';
import { TenantsCannotListSpots } from '../memberships/reviews-repository.ts';
import { AlreadyMember } from '../memberships/signup-repository.ts';
import { EmailAlreadyRegistered, normalizeEmail } from '../users/users-repository.ts';

const ASK_AGAIN = 'Peça um novo convite ao síndico.';

export const InviteNotFound = createError(
  'INVITE_NOT_FOUND',
  `Convite não encontrado. Confira o link ou ${ASK_AGAIN.toLowerCase()}`,
  404,
);
export const InviteUsed = createError(
  'INVITE_USED',
  `Este convite já foi usado. ${ASK_AGAIN}`,
  410,
);
export const InviteExpired = createError(
  'INVITE_EXPIRED',
  `Este convite venceu. ${ASK_AGAIN}`,
  410,
);
export const InviteRevoked = createError(
  'INVITE_REVOKED',
  `Este convite foi cancelado pelo síndico. ${ASK_AGAIN}`,
  410,
);
export const InviteNotSendable = createError(
  'INVITE_NOT_SENDABLE',
  'Só convites ainda válidos podem ser enviados. Gere um novo convite.',
  409,
);

export const InviteNotRevocable = createError(
  'INVITE_NOT_REVOCABLE',
  'Este convite já foi usado ou cancelado.',
  409,
);

export type InviteStatus = 'pending' | 'used' | 'expired' | 'revoked';
export type Relation = 'owner' | 'tenant';

type InviteState = {
  used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
};

export function inviteStatus(invite: InviteState, now = new Date()): InviteStatus {
  if (invite.used_at) return 'used';
  if (invite.revoked_at) return 'revoked';
  if (invite.expires_at <= now) return 'expired';
  return 'pending';
}

/** Erro com o motivo de um convite que não pode ser usado (req. 13, 14; cenários da spec). */
function unusable(invite: InviteState | undefined): Error {
  if (!invite) return new InviteNotFound();
  switch (inviteStatus(invite)) {
    case 'used':
      return new InviteUsed();
    case 'revoked':
      return new InviteRevoked();
    case 'expired':
      return new InviteExpired();
    case 'pending':
      // Só acontece se o convite ficou válido no meio do caminho: trata como não encontrado.
      return new InviteNotFound();
  }
}

export type InviteListItem = {
  id: string;
  status: InviteStatus;
  unit: { id: string; number: string; block: { id: string; name: string } };
  unit_relation: Relation;
  can_list_spots: boolean;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
  /** Para quem a plataforma enviou o convite por último (T19). */
  recipient_email: string | null;
  used_by: { id: string; name: string } | null;
};

export type PublicInvite = {
  condominium: { name: string };
  unit: { number: string; block: { name: string } };
  unit_relation: Relation;
  expires_at: Date;
};

export type NewResident = { name: string; email: string; phone: string; passwordHash: string };

/**
 * Convites individuais (spec 001, req. 10–14; plano 001, D10). O banco guarda só o hash
 * do token. O aceite marca o convite com um UPDATE condicional (`used_at is null and
 * revoked_at is null and expires_at > now()`): com duas pessoas ao mesmo tempo, só uma
 * passa; a outra desfaz a transação inteira (inclusive a conta que acabou de criar).
 */
export function createInvitesRepository(db: Db) {
  function listQuery(executor: Db) {
    return executor
      .selectFrom('invites as i')
      .innerJoin('units as u', 'u.id', 'i.unit_id')
      .innerJoin('blocks as b', 'b.id', 'u.block_id')
      .leftJoin('users as usr', 'usr.id', 'i.used_by')
      .select([
        'i.id',
        'i.unit_relation',
        'i.can_list_spots',
        'i.created_at',
        'i.expires_at',
        'i.used_at',
        'i.revoked_at',
        'i.recipient_email',
        'u.id as unit_id',
        'u.number as unit_number',
        'b.id as block_id',
        'b.name as block_name',
        'usr.id as used_by_id',
        'usr.name as used_by_name',
      ]);
  }

  type ListRow = Awaited<ReturnType<ReturnType<typeof listQuery>['executeTakeFirstOrThrow']>>;

  function toListItem(row: ListRow): InviteListItem {
    return {
      id: row.id,
      status: inviteStatus(row),
      unit: {
        id: row.unit_id,
        number: row.unit_number,
        block: { id: row.block_id, name: row.block_name },
      },
      unit_relation: row.unit_relation,
      can_list_spots: row.can_list_spots,
      created_at: row.created_at,
      expires_at: row.expires_at,
      used_at: row.used_at,
      revoked_at: row.revoked_at,
      recipient_email: row.recipient_email,
      used_by:
        row.used_by_id && row.used_by_name ? { id: row.used_by_id, name: row.used_by_name } : null,
    };
  }

  /** Marca o convite como usado por `userId` e cria o vínculo aprovado, na transação dada. */
  async function consume(trx: Db, tokenHash: Buffer, userId: string) {
    const invite = await trx
      .updateTable('invites')
      .set({ used_at: new Date(), used_by: userId })
      .where('token_hash', '=', tokenHash)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .returning(['id', 'condominium_id', 'unit_id', 'unit_relation', 'can_list_spots'])
      .executeTakeFirst();
    if (!invite) {
      const state = await trx
        .selectFrom('invites')
        .select(['used_at', 'revoked_at', 'expires_at'])
        .where('token_hash', '=', tokenHash)
        .executeTakeFirst();
      throw unusable(state);
    }

    // A regra de inquilinos pode ter sido desligada depois do convite (req. 3, 17).
    const condominium = await trx
      .selectFrom('condominiums')
      .select(['id', 'name', 'tenants_can_list_spots'])
      .where('id', '=', invite.condominium_id)
      .forShare()
      .executeTakeFirstOrThrow();
    const canListSpots =
      invite.can_list_spots &&
      (invite.unit_relation === 'owner' || condominium.tenants_can_list_spots);

    try {
      const membership = await trx
        .insertInto('memberships')
        .values({
          user_id: userId,
          condominium_id: invite.condominium_id,
          unit_id: invite.unit_id,
          unit_relation: invite.unit_relation,
          role: 'resident',
          status: 'approved',
          can_list_spots: canListSpots,
          origin: 'invite',
          decided_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return {
        membershipId: membership.id,
        condominium: { id: condominium.id, name: condominium.name },
      };
    } catch (err) {
      if (isUniqueViolation(err, 'memberships_one_active_per_user')) throw new AlreadyMember();
      throw err;
    }
  }

  return {
    async create(input: {
      condominiumId: string;
      unitId: string;
      unitRelation: Relation;
      canListSpots: boolean;
      tokenHash: Buffer;
      createdBy: string;
    }): Promise<InviteListItem> {
      return db.transaction().execute(async (trx) => {
        const condominium = await trx
          .selectFrom('condominiums')
          .select(['tenants_can_list_spots', 'invite_validity_days'])
          .where('id', '=', input.condominiumId)
          .forShare()
          .executeTakeFirstOrThrow();
        if (input.canListSpots && input.unitRelation === 'tenant') {
          if (!condominium.tenants_can_list_spots) throw new TenantsCannotListSpots();
        }

        const unit = await trx
          .selectFrom('units')
          .select('id')
          .where('condominium_id', '=', input.condominiumId)
          .where('id', '=', input.unitId)
          .executeTakeFirst();
        if (!unit) throw new UnitNotFound();

        const created = await trx
          .insertInto('invites')
          .values({
            condominium_id: input.condominiumId,
            unit_id: input.unitId,
            unit_relation: input.unitRelation,
            can_list_spots: input.canListSpots,
            token_hash: input.tokenHash,
            created_by: input.createdBy,
            expires_at: sql<Date>`now() + make_interval(days => ${condominium.invite_validity_days})`,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        return toListItem(
          await listQuery(trx).where('i.id', '=', created.id).executeTakeFirstOrThrow(),
        );
      });
    },

    /** Convites do condomínio, do mais novo ao mais antigo. */
    async list(condominiumId: string): Promise<InviteListItem[]> {
      const rows = await listQuery(db)
        .where('i.condominium_id', '=', condominiumId)
        .orderBy('i.created_at', 'desc')
        .execute();
      return rows.map(toListItem);
    },

    /**
     * Prepara o envio pela plataforma (req. 11): troca o token do convite pendente (o
     * banco só tem o hash do anterior, não há como reenviá-lo) e guarda o destinatário.
     * O link entregue antes deixa de valer. Usado, cancelado ou vencido → `InviteNotSendable`.
     */
    async rotateForSending(
      condominiumId: string,
      inviteId: string,
      input: { tokenHash: Buffer; recipientEmail: string },
    ): Promise<InviteListItem & { condominium_name: string }> {
      return db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable('invites')
          .set({
            token_hash: input.tokenHash,
            recipient_email: normalizeEmail(input.recipientEmail),
          })
          .where('condominium_id', '=', condominiumId)
          .where('id', '=', inviteId)
          .where('used_at', 'is', null)
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', sql<Date>`now()`)
          .returning('id')
          .executeTakeFirst();
        if (!updated) {
          const exists = await trx
            .selectFrom('invites')
            .select('id')
            .where('condominium_id', '=', condominiumId)
            .where('id', '=', inviteId)
            .executeTakeFirst();
          throw exists ? new InviteNotSendable() : new InviteNotFound();
        }
        const [row, condominium] = await Promise.all([
          listQuery(trx).where('i.id', '=', inviteId).executeTakeFirstOrThrow(),
          trx
            .selectFrom('condominiums')
            .select('name')
            .where('id', '=', condominiumId)
            .executeTakeFirstOrThrow(),
        ]);
        return { ...toListItem(row), condominium_name: condominium.name };
      });
    },

    /** Cancela um convite ainda não usado (req. 14). Vencido também pode ser cancelado. */
    async revoke(condominiumId: string, inviteId: string): Promise<void> {
      const result = await db
        .updateTable('invites')
        .set({ revoked_at: new Date() })
        .where('condominium_id', '=', condominiumId)
        .where('id', '=', inviteId)
        .where('used_at', 'is', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (result.numUpdatedRows > 0n) return;

      const exists = await db
        .selectFrom('invites')
        .select('id')
        .where('condominium_id', '=', condominiumId)
        .where('id', '=', inviteId)
        .executeTakeFirst();
      throw exists ? new InviteNotRevocable() : new InviteNotFound();
    },

    /** O que a tela do convite mostra antes do cadastro, ou o motivo de não valer. */
    async findForPublic(tokenHash: Buffer): Promise<PublicInvite> {
      const row = await db
        .selectFrom('invites as i')
        .innerJoin('condominiums as c', 'c.id', 'i.condominium_id')
        .innerJoin('units as u', 'u.id', 'i.unit_id')
        .innerJoin('blocks as b', 'b.id', 'u.block_id')
        .select([
          'i.used_at',
          'i.revoked_at',
          'i.expires_at',
          'i.unit_relation',
          'c.name as condominium_name',
          'u.number as unit_number',
          'b.name as block_name',
        ])
        .where('i.token_hash', '=', tokenHash)
        .executeTakeFirst();
      if (!row || inviteStatus(row) !== 'pending') throw unusable(row);
      return {
        condominium: { name: row.condominium_name },
        unit: { number: row.unit_number, block: { name: row.block_name } },
        unit_relation: row.unit_relation,
        expires_at: row.expires_at,
      };
    },

    /** Conta nova + vínculo aprovado. E-mail já cadastrado → `EmailAlreadyRegistered`. */
    async acceptWithNewUser(tokenHash: Buffer, user: NewResident) {
      return db.transaction().execute(async (trx) => {
        // Confere o convite antes de criar a conta: a resposta fala do convite, não do e-mail.
        const state = await trx
          .selectFrom('invites')
          .select(['used_at', 'revoked_at', 'expires_at'])
          .where('token_hash', '=', tokenHash)
          .executeTakeFirst();
        if (!state || inviteStatus(state) !== 'pending') throw unusable(state);

        let userId: string;
        try {
          const created = await trx
            .insertInto('users')
            .values({
              name: user.name.trim(),
              email: normalizeEmail(user.email),
              phone: user.phone,
              password_hash: user.passwordHash,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          userId = created.id;
        } catch (err) {
          if (isUniqueViolation(err, 'users_email_key')) throw new EmailAlreadyRegistered();
          throw err;
        }
        return consume(trx, tokenHash, userId);
      });
    },

    /** Quem já tem conta (ex.: mora em outro condomínio) usa o convite logado. */
    async acceptWithExistingUser(tokenHash: Buffer, userId: string) {
      return db.transaction().execute((trx) => consume(trx, tokenHash, userId));
    },
  };
}

export type InvitesRepository = ReturnType<typeof createInvitesRepository>;

export default fp(
  async function invitesRepositoryPlugin(fastify) {
    fastify.decorate('invitesRepository', createInvitesRepository(fastify.db));
  },
  { name: 'invites-repository', dependencies: ['db'] },
);

declare module 'fastify' {
  interface FastifyInstance {
    invitesRepository: InvitesRepository;
  }
}
