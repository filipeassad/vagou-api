import fp from 'fastify-plugin';
import { sql } from 'kysely';
import { isUniqueViolation, type Db } from '../../external/db.ts';
import { assertValidTimezone } from './timezones.ts';
import { EmailAlreadyRegistered, normalizeEmail } from '../users/users-repository.ts';

const PUBLIC_COLUMNS = [
  'id',
  'name',
  'address',
  'tenants_can_list_spots',
  'invite_validity_days',
  'timezone',
] as const;

/** Código do QR Code já usado (colisão rara: quem chama gera outro e tenta de novo). */
export class PublicCodeTaken extends Error {
  constructor() {
    super('public_code já usado');
    this.name = 'PublicCodeTaken';
  }
}

export type NewCondominiumWithManager = {
  name: string;
  address: string;
  timezone: string;
  publicCode: string;
  /** Usuário existente (pelo id) ou conta nova, sem senha. */
  manager: { userId: string } | { name: string; email: string; phone: string | null };
  /** Link de definir senha do síndico (D10: só o hash), quando ele ainda não tem senha. */
  setupToken: { hash: Buffer; ttlMinutes: number } | null;
};

export type CondominiumPatch = {
  name?: string;
  address?: string;
  timezone?: string;
  tenants_can_list_spots?: boolean;
  invite_validity_days?: number;
};

export type AdminCondominium = {
  id: string;
  name: string;
  address: string;
  public_code: string;
  timezone: string;
  created_at: Date;
  manager: { id: string; name: string; email: string } | null;
};

/** Condomínios (plano 001, seção 3). */
export function createCondominiumsRepository(db: Db) {
  function adminQuery(executor: Db) {
    return executor
      .selectFrom('condominiums as c')
      .leftJoin('memberships as m', (join) =>
        join
          .onRef('m.condominium_id', '=', 'c.id')
          .on('m.role', '=', 'manager')
          .on('m.status', '=', 'approved'),
      )
      .leftJoin('users as u', 'u.id', 'm.user_id')
      .select([
        'c.id',
        'c.name',
        'c.address',
        'c.public_code',
        'c.timezone',
        'c.created_at',
        'u.id as manager_id',
        'u.name as manager_name',
        'u.email as manager_email',
      ]);
  }

  type AdminRow = Awaited<ReturnType<ReturnType<typeof adminQuery>['executeTakeFirstOrThrow']>>;

  function toAdminCondominium({
    manager_id,
    manager_name,
    manager_email,
    ...condominium
  }: AdminRow): AdminCondominium {
    return {
      ...condominium,
      manager:
        manager_id && manager_name && manager_email
          ? { id: manager_id, name: manager_name, email: manager_email }
          : null,
    };
  }

  return {
    /** Condomínio do link/QR Code (req. 6). O código é gerado em maiúsculas (T12). */
    findByPublicCode(code: string) {
      return db
        .selectFrom('condominiums')
        .select(['id', 'name'])
        .where('public_code', '=', code.trim().toUpperCase())
        .executeTakeFirst();
    },

    findById(id: string) {
      return db
        .selectFrom('condominiums')
        .select(PUBLIC_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
    },

    /**
     * Atualiza dados e configurações (req. 2, 3, 13). Desligar `tenants_can_list_spots`
     * tira, na mesma transação, a permissão de anunciar de todos os inquilinos do
     * condomínio (a configuração vale para quem já está aprovado, não só para os novos).
     */
    async update(id: string, patch: CondominiumPatch) {
      if (patch.timezone !== undefined) assertValidTimezone(patch.timezone);
      return db.transaction().execute(async (trx) => {
        await trx
          .updateTable('condominiums')
          .set({
            ...(patch.name !== undefined && { name: patch.name.trim() }),
            ...(patch.address !== undefined && { address: patch.address.trim() }),
            ...(patch.timezone !== undefined && { timezone: patch.timezone }),
            ...(patch.tenants_can_list_spots !== undefined && {
              tenants_can_list_spots: patch.tenants_can_list_spots,
            }),
            ...(patch.invite_validity_days !== undefined && {
              invite_validity_days: patch.invite_validity_days,
            }),
          })
          .where('id', '=', id)
          .execute();

        if (patch.tenants_can_list_spots === false) {
          await trx
            .updateTable('memberships')
            .set({ can_list_spots: false })
            .where('condominium_id', '=', id)
            .where('unit_relation', '=', 'tenant')
            .where('can_list_spots', '=', true)
            .execute();
        }

        return trx
          .selectFrom('condominiums')
          .select(PUBLIC_COLUMNS)
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
      });
    },

    /** Lista para o admin (D11), por nome. Poucos condomínios no MVP: sem paginação. */
    async listForAdmin(): Promise<AdminCondominium[]> {
      const rows = await adminQuery(db).orderBy('c.name').execute();
      return rows.map(toAdminCondominium);
    },

    /**
     * Cria condomínio, conta do síndico (se nova), vínculo de síndico aprovado e o link
     * de definir senha, tudo numa transação: nunca fica condomínio sem síndico.
     */
    async createWithManager(input: NewCondominiumWithManager): Promise<AdminCondominium> {
      return db.transaction().execute(async (trx) => {
        let condominiumId: string;
        try {
          ({ id: condominiumId } = await trx
            .insertInto('condominiums')
            .values({
              name: input.name.trim(),
              address: input.address.trim(),
              timezone: input.timezone,
              public_code: input.publicCode,
            })
            .returning('id')
            .executeTakeFirstOrThrow());
        } catch (err) {
          if (isUniqueViolation(err, 'condominiums_public_code_key')) throw new PublicCodeTaken();
          throw err;
        }

        let managerId: string;
        if ('userId' in input.manager) {
          managerId = input.manager.userId;
        } else {
          try {
            ({ id: managerId } = await trx
              .insertInto('users')
              .values({
                name: input.manager.name.trim(),
                email: normalizeEmail(input.manager.email),
                phone: input.manager.phone,
                password_hash: null,
              })
              .returning('id')
              .executeTakeFirstOrThrow());
          } catch (err) {
            if (isUniqueViolation(err, 'users_email_key')) throw new EmailAlreadyRegistered();
            throw err;
          }
        }

        await trx
          .insertInto('memberships')
          .values({
            user_id: managerId,
            condominium_id: condominiumId,
            role: 'manager',
            status: 'approved',
            origin: 'admin',
            decided_at: sql`now()`,
          })
          .execute();

        if (input.setupToken) {
          await trx
            .updateTable('password_resets')
            .set({ used_at: sql`now()` })
            .where('user_id', '=', managerId)
            .where('used_at', 'is', null)
            .execute();
          await trx
            .insertInto('password_resets')
            .values({
              user_id: managerId,
              token_hash: input.setupToken.hash,
              expires_at: sql`now() + make_interval(mins => ${input.setupToken.ttlMinutes})`,
            })
            .execute();
        }

        const row = await adminQuery(trx)
          .where('c.id', '=', condominiumId)
          .executeTakeFirstOrThrow();
        return toAdminCondominium(row);
      });
    },
  };
}

export type CondominiumsRepository = ReturnType<typeof createCondominiumsRepository>;

export default fp(
  async function condominiumsRepositoryPlugin(fastify) {
    fastify.decorate('condominiumsRepository', createCondominiumsRepository(fastify.db));
  },
  { name: 'condominiums-repository', dependencies: ['db'] },
);

declare module 'fastify' {
  interface FastifyInstance {
    condominiumsRepository: CondominiumsRepository;
  }
}
