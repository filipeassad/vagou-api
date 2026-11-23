import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCondominium, createMember, signIn } from '../../../fixtures.ts';
import { buildTestApp, sentNotifications } from '../../../helper.ts';
import { resetDatabase } from '../../../test-database.ts';

type Condo = Awaited<ReturnType<typeof createCondominium>>;

/** Spec 001, req. 6–9 e cenário "cadastro pelo QR Code". */
describe('cadastro pelo QR Code', () => {
  let app: FastifyInstance;
  let condo: Condo;
  let manager: Awaited<ReturnType<typeof createMember>>;
  let ipCounter = 0;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    sentNotifications(app).length = 0;
    condo = await createCondominium(app);
    manager = await createMember(app, condo, { role: 'manager' });
  });

  /** IP próprio por chamada, longe do rate limit. */
  function newIp() {
    ipCounter += 1;
    return `10.7.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
  }

  function signup(body: Record<string, unknown>, code = condo.publicCode) {
    return app.inject({
      method: 'POST',
      url: `/v1/public/condominiums/${code}/signup`,
      payload: body,
      remoteAddress: newIp(),
    });
  }

  const joana = (overrides: Record<string, unknown> = {}) => ({
    name: '  Joana Lima ',
    email: 'joana@example.com',
    phone: '(67) 99999-1234',
    password: 'senha-da-joana',
    unit_id: condo.unitId,
    unit_relation: 'tenant',
    ...overrides,
  });

  describe('GET /v1/public/condominiums/:code', () => {
    it('devolve o nome e só os blocos e unidades daquele condomínio', async () => {
      const other = await createCondominium(app);
      await app.db
        .insertInto('blocks')
        .values({ condominium_id: other.id, name: 'Torre Alheia' })
        .execute();

      const res = await app.inject({ url: `/v1/public/condominiums/${condo.publicCode}` });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toMatch(/^Residencial /);
      expect(body.blocks).toEqual([
        { id: condo.blockId, name: 'Bloco A', units: [{ id: condo.unitId, number: '101' }] },
      ]);
      expect(Object.keys(body)).toEqual(['name', 'blocks']);
    });

    it('aceita o código em minúsculas', async () => {
      const res = await app.inject({
        url: `/v1/public/condominiums/${condo.publicCode.toLowerCase()}`,
      });
      expect(res.statusCode).toBe(200);
    });

    it('código inexistente → 404', async () => {
      const res = await app.inject({ url: '/v1/public/condominiums/NAOEXISTE' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('CONDOMINIUM_NOT_FOUND');
    });
  });

  describe('POST /v1/public/condominiums/:code/signup', () => {
    it('cria a conta com vínculo pendente e avisa o síndico', async () => {
      const res = await signup(joana());

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ membership_id: expect.any(String), status: 'pending' });

      const row = await app.db
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select(['u.name', 'u.phone', 'm.role', 'm.status', 'm.origin', 'm.unit_relation'])
        .select(['m.unit_id', 'm.can_list_spots'])
        .where('m.id', '=', res.json().membership_id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({
        name: 'Joana Lima',
        phone: '67999991234',
        role: 'resident',
        status: 'pending',
        origin: 'qr_code',
        unit_relation: 'tenant',
        unit_id: condo.unitId,
        can_list_spots: false,
      });

      await vi.waitFor(() => expect(sentNotifications(app)).toHaveLength(1));
      expect(sentNotifications(app)[0]).toMatchObject({
        type: 'membership_pending',
        to: { email: manager.user.email },
        residentName: 'Joana Lima',
        unitLabel: 'Bloco A, unidade 101',
        reviewUrl: expect.stringContaining(`/condominios/${condo.id}/moradores`),
      });
    });

    it('depois do login, o morador vê o vínculo pendente e não acessa o condomínio', async () => {
      await signup(joana());
      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'joana@example.com', password: 'senha-da-joana', client: 'mobile' },
        remoteAddress: newIp(),
      });
      const headers = { authorization: `Bearer ${login.json().access_token}` };

      const me = await app.inject({ url: '/v1/me', headers });
      expect(me.json().memberships).toMatchObject([{ status: 'pending', role: 'resident' }]);
      const condoRes = await app.inject({ url: `/v1/condominiums/${condo.id}`, headers });
      expect(condoRes.statusCode).toBe(403);
      expect(condoRes.json().error.code).toBe('MEMBERSHIP_PENDING');
    });

    it('unidade de outro condomínio é recusada e nada é criado', async () => {
      const other = await createCondominium(app);

      const res = await signup(joana({ unit_id: other.unitId }));

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('UNIT_NOT_FOUND');
      const user = await app.db
        .selectFrom('users')
        .select('id')
        .where('email', '=', 'joana@example.com')
        .executeTakeFirst();
      expect(user).toBeUndefined();
    });

    it('código inexistente → 404', async () => {
      const res = await signup(joana(), 'NAOEXISTE');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('CONDOMINIUM_NOT_FOUND');
    });

    it('e-mail já cadastrado → 409 (quem tem conta entra e pede acesso logado)', async () => {
      const res = await signup(joana({ email: manager.user.email.toUpperCase() }));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('EMAIL_ALREADY_REGISTERED');
    });

    it('valida telefone, senha e tipo de vínculo', async () => {
      for (const invalid of [
        { phone: 'abc' },
        { password: 'curta' },
        { unit_relation: 'visitante' },
        { name: 'J' },
      ]) {
        expect((await signup(joana(invalid))).statusCode).toBe(400);
      }
    });

    it('condomínio sem síndico: o cadastro fica pendente e ninguém é avisado', async () => {
      await app.db.deleteFrom('memberships').where('id', '=', manager.membershipId).execute();

      const res = await signup(joana());

      expect(res.statusCode).toBe(201);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sentNotifications(app)).toHaveLength(0);
    });
  });

  describe('POST /v1/me/memberships (quem já tem conta)', () => {
    it('morador de outro condomínio pede acesso com a mesma conta', async () => {
      const other = await createCondominium(app);
      const resident = await createMember(app, other);
      const headers = (await signIn(app, resident.user.id)).headers;

      const res = await app.inject({
        method: 'POST',
        url: '/v1/me/memberships',
        payload: { public_code: condo.publicCode, unit_id: condo.unitId, unit_relation: 'owner' },
        headers,
      });

      expect(res.statusCode).toBe(201);
      const me = await app.inject({ url: '/v1/me', headers });
      expect(me.json().memberships.map((m: { status: string }) => m.status)).toEqual([
        'approved',
        'pending',
      ]);
      await vi.waitFor(() =>
        expect(sentNotifications(app)).toMatchObject([
          { type: 'membership_pending', residentName: resident.user.name },
        ]),
      );
    });

    it('quem já tem vínculo no condomínio → 409; sem login → 401', async () => {
      const headers = (await signIn(app, manager.user.id)).headers;
      const payload = {
        public_code: condo.publicCode,
        unit_id: condo.unitId,
        unit_relation: 'owner',
      };

      const again = await app.inject({
        method: 'POST',
        url: '/v1/me/memberships',
        payload,
        headers,
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('ALREADY_MEMBER');

      const anonymous = await app.inject({ method: 'POST', url: '/v1/me/memberships', payload });
      expect(anonymous.statusCode).toBe(401);
    });
  });
});
