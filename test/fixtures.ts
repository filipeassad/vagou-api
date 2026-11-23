import type { FastifyInstance } from 'fastify';
import { generateOpaqueToken, hashOpaqueToken } from '../src/plugins/app/auth/opaque-token.ts';
import type {
  MembershipRole,
  MembershipStatus,
} from '../src/plugins/app/memberships/memberships-repository.ts';

/**
 * Atalhos para montar cenários nos testes direto no banco (sem passar pelas rotas e
 * sem esbarrar no rate limit do login). Use depois de `resetDatabase()`.
 */

let sequence = 0;
const next = () => ++sequence;

export async function createUser(app: FastifyInstance, overrides: { email?: string } = {}) {
  return app.usersRepository.create({
    name: `Pessoa ${next()}`,
    email: overrides.email ?? `pessoa${sequence}@example.com`,
    phone: '67999990000',
    passwordHash: null,
  });
}

export async function createCondominium(app: FastifyInstance) {
  const n = next();
  const condominium = await app.db
    .insertInto('condominiums')
    .values({ name: `Residencial ${n}`, address: `Rua ${n}, 100`, public_code: `COND${n}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  const block = await app.db
    .insertInto('blocks')
    .values({ condominium_id: condominium.id, name: 'Bloco A' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const unit = await app.db
    .insertInto('units')
    .values({ condominium_id: condominium.id, block_id: block.id, number: '101' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: condominium.id, blockId: block.id, unitId: unit.id, publicCode: `COND${n}` };
}

/** Cria um usuário com vínculo no condomínio (morador ganha a unidade 101). */
export async function createMember(
  app: FastifyInstance,
  condominium: { id: string; unitId: string },
  {
    role = 'resident',
    status = 'approved',
  }: { role?: MembershipRole; status?: MembershipStatus } = {},
) {
  const user = await createUser(app);
  const hasUnit = role !== 'front_desk';
  const membership = await app.db
    .insertInto('memberships')
    .values({
      user_id: user.id,
      condominium_id: condominium.id,
      unit_id: hasUnit ? condominium.unitId : null,
      unit_relation: hasUnit ? 'owner' : null,
      role,
      status,
      origin: 'admin',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { user, membershipId: membership.id };
}

/** Abre uma sessão para o usuário; `headers` já vem com o Authorization pronto. */
export async function signIn(app: FastifyInstance, userId: string) {
  const session = await app.sessionsRepository.create({
    userId,
    refreshTokenHash: hashOpaqueToken(generateOpaqueToken()),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    userAgent: 'vitest',
  });
  const token = app.jwt.sign({ sub: userId, sid: session.id });
  return { headers: { authorization: `Bearer ${token}` }, sessionId: session.id };
}
