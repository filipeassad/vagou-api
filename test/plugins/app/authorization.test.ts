import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCESS } from '../../../src/plugins/app/authorization.ts';
import { createCondominium, createMember, signIn } from '../../fixtures.ts';
import { buildTestApp } from '../../helper.ts';
import { resetDatabase } from '../../test-database.ts';

/**
 * Princípio I (INEGOCIÁVEL): cada condomínio é um mundo fechado.
 * Usa a rota real GET /v1/condominiums/:cid e rotas de teste com cada regra de acesso,
 * protegidas pelos mesmos hooks do routes/v1/condominiums/autohooks.ts.
 */
describe('autorização por condomínio', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp({
      beforeReady: async (instance) => {
        await instance.register(
          async (scope) => {
            scope.addHook('onRequest', instance.authenticate);
            scope.addHook('onRequest', instance.authorizeCondominium);
            const ok = async () => ({ ok: true });
            scope.get('/default', ok);
            scope.get('/manager', { config: { access: ACCESS.manager } }, ok);
            scope.get('/front-desk', { config: { access: ACCESS.frontDesk } }, ok);
            scope.get(
              '/me',
              {
                config: {
                  access: { roles: ['resident'], statuses: ['pending', 'approved', 'rejected'] },
                },
              },
              async (request) => ({ status: request.membership?.status }),
            );
          },
          { prefix: '/test/condominiums/:cid' },
        );
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
  });

  async function get(url: string, headers: Record<string, string> = {}) {
    return app.inject({ method: 'GET', url, headers });
  }

  it('sem login → 401 UNAUTHENTICATED; token inválido também', async () => {
    const a = await createCondominium(app);

    const none = await get(`/v1/condominiums/${a.id}`);
    const invalid = await get(`/v1/condominiums/${a.id}`, { authorization: 'Bearer abc.def.ghi' });

    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('UNAUTHENTICATED');
    expect(invalid.statusCode).toBe(401);
  });

  it('token assinado com outro segredo é recusado', async () => {
    const a = await createCondominium(app);
    const { user } = await createMember(app, a);
    const other = await buildTestApp({
      config: { JWT_SECRET: 'outro-segredo-com-pelo-menos-32-caracteres' },
    });
    const forged = other.jwt.sign({ sub: user.id, sid: '00000000-0000-0000-0000-000000000000' });
    await other.close();

    const res = await get(`/v1/condominiums/${a.id}`, { authorization: `Bearer ${forged}` });

    expect(res.statusCode).toBe(401);
  });

  it('morador do condomínio A vê A e recebe 404 em B (req. 26)', async () => {
    const a = await createCondominium(app);
    const b = await createCondominium(app);
    const { user } = await createMember(app, a);
    const { headers } = await signIn(app, user.id);

    const own = await get(`/v1/condominiums/${a.id}`, headers);
    const foreign = await get(`/v1/condominiums/${b.id}`, headers);

    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({
      id: a.id,
      invite_validity_days: 7,
      tenants_can_list_spots: true,
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error).toEqual({
      code: 'CONDOMINIUM_NOT_FOUND',
      message: 'Condomínio não encontrado.',
    });
  });

  it('condomínio inexistente e id malformado respondem o mesmo 404 do condomínio alheio', async () => {
    const a = await createCondominium(app);
    const { user } = await createMember(app, a);
    const { headers } = await signIn(app, user.id);

    const missing = await get('/v1/condominiums/00000000-0000-0000-0000-000000000000', headers);
    const malformed = await get('/v1/condominiums/nao-e-uuid', headers);

    expect(missing.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json().error.code).toBe('CONDOMINIUM_NOT_FOUND');
  });

  it('vínculo pendente recebe 403 em rota de morador aprovado (req. 15)', async () => {
    const a = await createCondominium(app);
    const { user } = await createMember(app, a, { status: 'pending' });
    const { headers } = await signIn(app, user.id);

    const res = await get(`/test/condominiums/${a.id}/default`, headers);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MEMBERSHIP_PENDING');
  });

  it('vínculo recusado recebe 403 MEMBERSHIP_REJECTED', async () => {
    const a = await createCondominium(app);
    const { user } = await createMember(app, a, { status: 'rejected' });
    const { headers } = await signIn(app, user.id);

    const res = await get(`/test/condominiums/${a.id}/default`, headers);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MEMBERSHIP_REJECTED');
  });

  it('rota que aceita pendente (ex.: corrigir o próprio cadastro) deixa passar', async () => {
    const a = await createCondominium(app);
    const { user } = await createMember(app, a, { status: 'pending' });
    const { headers } = await signIn(app, user.id);

    const res = await get(`/test/condominiums/${a.id}/me`, headers);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'pending' });
  });

  it('síndico acessa rota de síndico; morador e portaria não', async () => {
    const a = await createCondominium(app);
    const manager = await createMember(app, a, { role: 'manager' });
    const resident = await createMember(app, a);
    const frontDesk = await createMember(app, a, { role: 'front_desk' });
    const url = `/test/condominiums/${a.id}/manager`;

    const asManager = await get(url, (await signIn(app, manager.user.id)).headers);
    const asResident = await get(url, (await signIn(app, resident.user.id)).headers);
    const asFrontDesk = await get(url, (await signIn(app, frontDesk.user.id)).headers);

    expect(asManager.statusCode).toBe(200);
    expect(asResident.statusCode).toBe(403);
    expect(asResident.json().error.code).toBe('FORBIDDEN');
    expect(asFrontDesk.statusCode).toBe(403);
  });

  it('regra padrão: morador e síndico passam, portaria não', async () => {
    const a = await createCondominium(app);
    const url = `/test/condominiums/${a.id}/default`;

    for (const [role, expected] of [
      ['resident', 200],
      ['manager', 200],
      ['front_desk', 403],
    ] as const) {
      const member = await createMember(app, a, { role });
      const res = await get(url, (await signIn(app, member.user.id)).headers);
      expect(res.statusCode, role).toBe(expected);
    }
  });

  it('rota da portaria: só a portaria passa', async () => {
    const a = await createCondominium(app);
    const frontDesk = await createMember(app, a, { role: 'front_desk' });
    const resident = await createMember(app, a);
    const url = `/test/condominiums/${a.id}/front-desk`;

    expect((await get(url, (await signIn(app, frontDesk.user.id)).headers)).statusCode).toBe(200);
    expect((await get(url, (await signIn(app, resident.user.id)).headers)).statusCode).toBe(403);
  });

  it('sessão encerrada (logout) corta o acesso na hora, mesmo com o JWT ainda válido', async () => {
    const a = await createCondominium(app);
    const { user } = await createMember(app, a);
    const { headers, sessionId } = await signIn(app, user.id);
    expect((await get(`/v1/condominiums/${a.id}`, headers)).statusCode).toBe(200);

    await app.sessionsRepository.revoke(sessionId);

    const res = await get(`/v1/condominiums/${a.id}`, headers);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('vínculo removido perde o acesso no request seguinte (vínculo conferido a cada requisição)', async () => {
    const a = await createCondominium(app);
    const { user, membershipId } = await createMember(app, a);
    const { headers } = await signIn(app, user.id);
    expect((await get(`/v1/condominiums/${a.id}`, headers)).statusCode).toBe(200);

    await app.db
      .updateTable('memberships')
      .set({ status: 'removed' })
      .where('id', '=', membershipId)
      .execute();

    expect((await get(`/v1/condominiums/${a.id}`, headers)).statusCode).toBe(404);
  });
});
