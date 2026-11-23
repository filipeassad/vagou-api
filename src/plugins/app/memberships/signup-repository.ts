import createError from '@fastify/error';
import fp from 'fastify-plugin';
import { isUniqueViolation, type Db } from '../../external/db.ts';
import { UnitNotFound } from '../condominiums/units-repository.ts';
import { EmailAlreadyRegistered, normalizeEmail } from '../users/users-repository.ts';

/** Já tem vínculo (pendente, aprovado ou recusado) com o condomínio: um por pessoa. */
export const AlreadyMember = createError(
  'ALREADY_MEMBER',
  'Você já tem cadastro neste condomínio. Entre na sua conta para ver a situação.',
  409,
);

export type AccessRequest = {
  condominiumId: string;
  unitId: string;
  unitRelation: 'owner' | 'tenant';
};

export type NewResident = {
  name: string;
  email: string;
  phone: string;
  passwordHash: string;
};

export type PendingMembership = {
  membershipId: string;
  userId: string;
  /** "Bloco A, unidade 101", para a notificação do síndico. */
  unitLabel: string;
};

/**
 * Cadastro pelo QR Code (req. 7–9): cria o vínculo **pendente** de morador, com conta
 * nova ou com a conta de quem já está logado. Tudo numa transação.
 */
export function createSignupRepository(db: Db) {
  async function insertPending(
    trx: Db,
    userId: string,
    request: AccessRequest,
  ): Promise<PendingMembership> {
    // A unidade precisa ser deste condomínio (req. 8; princípio I). A chave composta
    // (condominium_id, unit_id) também garante isso no banco.
    const unit = await trx
      .selectFrom('units as u')
      .innerJoin('blocks as b', 'b.id', 'u.block_id')
      .select(['u.number', 'b.name as block_name'])
      .where('u.condominium_id', '=', request.condominiumId)
      .where('u.id', '=', request.unitId)
      .executeTakeFirst();
    if (!unit) throw new UnitNotFound();

    try {
      const membership = await trx
        .insertInto('memberships')
        .values({
          user_id: userId,
          condominium_id: request.condominiumId,
          unit_id: request.unitId,
          unit_relation: request.unitRelation,
          role: 'resident',
          status: 'pending',
          origin: 'qr_code',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return {
        membershipId: membership.id,
        userId,
        unitLabel: `${unit.block_name}, unidade ${unit.number}`,
      };
    } catch (err) {
      if (isUniqueViolation(err, 'memberships_one_active_per_user')) throw new AlreadyMember();
      throw err;
    }
  }

  return {
    /** Conta nova + vínculo pendente. E-mail já cadastrado → `EmailAlreadyRegistered`. */
    async signup(user: NewResident, request: AccessRequest): Promise<PendingMembership> {
      return db.transaction().execute(async (trx) => {
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
        return insertPending(trx, userId, request);
      });
    },

    /** Quem já tem conta (ex.: mora em outro condomínio) pede acesso a mais um. */
    async join(userId: string, request: AccessRequest): Promise<PendingMembership> {
      return db.transaction().execute((trx) => insertPending(trx, userId, request));
    },

    /** Síndico aprovado, para avisar do cadastro novo. Sem síndico, ninguém é avisado. */
    findManager(condominiumId: string) {
      return db
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select(['u.id', 'u.name', 'u.email'])
        .where('m.condominium_id', '=', condominiumId)
        .where('m.role', '=', 'manager')
        .where('m.status', '=', 'approved')
        .executeTakeFirst();
    },
  };
}

export type SignupRepository = ReturnType<typeof createSignupRepository>;

export default fp(
  async function signupRepositoryPlugin(fastify) {
    fastify.decorate('signupRepository', createSignupRepository(fastify.db));
  },
  { name: 'signup-repository', dependencies: ['db'] },
);

declare module 'fastify' {
  interface FastifyInstance {
    signupRepository: SignupRepository;
  }
}
