import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCondominium, createMember, signIn } from '../../../fixtures.ts';
import { buildTestApp } from '../../../helper.ts';
import { resetDatabase } from '../../../test-database.ts';

describe('GET /v1/me', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
  });

  const me = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/v1/me', headers });

  it('devolve o usuário e o vínculo com condomínio, bloco e unidade', async () => {
    const a = await createCondominium(app);
    const { user, membershipId } = await createMember(app, a);
    const { headers } = await signIn(app, user.id);

    const res = await me(headers);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: '67999990000',
      is_admin: false,
      memberships: [
        {
          id: membershipId,
          role: 'resident',
          status: 'approved',
          can_list_spots: false,
          unit_relation: 'owner',
          rejection_reason: null,
          condominium: {
            id: a.id,
            name: expect.any(String),
            timezone: 'America/Sao_Paulo',
            public_code: a.publicCode,
          },
          unit: { id: a.unitId, number: '101', block: { id: a.blockId, name: 'Bloco A' } },
        },
      ],
    });
  });

  it('nunca expõe hash da senha nem controle de bloqueio', async () => {
    const a = await createCondominium(app);
    const { user } = await createMember(app, a);
    await app.db
      .updateTable('users')
      .set({ password_hash: await app.passwordManager.hash('senha-secreta-1') })
      .where('id', '=', user.id)
      .execute();

    const body = (await me((await signIn(app, user.id)).headers)).body;

    expect(body).not.toContain('password');
    expect(body).not.toContain('argon2');
    expect(body).not.toContain('failed_login_attempts');
    expect(body).not.toContain('locked_until');
  });

  it('não traz dados de outros usuários nem de outros condomínios', async () => {
    const a = await createCondominium(app);
    const b = await createCondominium(app);
    const maria = await createMember(app, a);
    const joao = await createMember(app, a, { role: 'manager' });
    await createMember(app, b);

    const res = await me((await signIn(app, maria.user.id)).headers);

    const body = res.json();
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].condominium.id).toBe(a.id);
    expect(res.body).not.toContain(joao.user.email);
    expect(res.body).not.toContain(b.id);
  });

  it('vínculo pendente e recusado (com motivo) aparecem; removido não', async () => {
    const a = await createCondominium(app);
    const b = await createCondominium(app);
    const c = await createCondominium(app);
    const { user, membershipId } = await createMember(app, a, { status: 'pending' });
    const rejected = await app.db
      .insertInto('memberships')
      .values({
        user_id: user.id,
        condominium_id: b.id,
        unit_id: b.unitId,
        unit_relation: 'tenant',
        role: 'resident',
        status: 'rejected',
        rejection_reason: 'Unidade não confere',
        origin: 'qr_code',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await app.db
      .insertInto('memberships')
      .values({
        user_id: user.id,
        condominium_id: c.id,
        unit_id: c.unitId,
        unit_relation: 'owner',
        role: 'resident',
        status: 'removed',
        origin: 'admin',
      })
      .execute();

    const res = await me((await signIn(app, user.id)).headers);

    expect(res.statusCode).toBe(200);
    expect(res.json().memberships).toMatchObject([
      { id: membershipId, status: 'pending' },
      { id: rejected.id, status: 'rejected', rejection_reason: 'Unidade não confere' },
    ]);
  });

  it('portaria aparece sem unidade', async () => {
    const a = await createCondominium(app);
    const { user } = await createMember(app, a, { role: 'front_desk' });

    const res = await me((await signIn(app, user.id)).headers);

    expect(res.json().memberships).toMatchObject([
      { role: 'front_desk', unit: null, unit_relation: null },
    ]);
  });

  it('usuário sem vínculo recebe lista vazia', async () => {
    const user = await app.usersRepository.create({
      name: 'Ana',
      email: 'ana@example.com',
      phone: null,
      passwordHash: null,
    });

    const res = await me((await signIn(app, user.id)).headers);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ phone: null, memberships: [] });
  });

  it('sem login ou com sessão encerrada → 401', async () => {
    const a = await createCondominium(app);
    const { user } = await createMember(app, a);
    const { headers, sessionId } = await signIn(app, user.id);
    await app.sessionsRepository.revoke(sessionId);

    expect((await me()).statusCode).toBe(401);
    expect((await me(headers)).json().error.code).toBe('UNAUTHENTICATED');
  });
});
