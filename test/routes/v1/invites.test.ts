import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCondominium, createMember, signIn } from '../../fixtures.ts';
import { buildTestApp, sentNotifications } from '../../helper.ts';
import { resetDatabase } from '../../test-database.ts';

type Condo = Awaited<ReturnType<typeof createCondominium>>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Spec 001, req. 10, 12–14, 17 e cenários de convite. */
describe('convites', () => {
  let app: FastifyInstance;
  let condo: Condo;
  let managerHeaders: Record<string, string>;
  let ipCounter = 0;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    condo = await createCondominium(app);
    const manager = await createMember(app, condo, { role: 'manager' });
    managerHeaders = (await signIn(app, manager.user.id)).headers;
  });

  function newIp() {
    ipCounter += 1;
    return `10.6.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
  }

  async function createInvite(
    body: Record<string, unknown> = {},
    headers = managerHeaders,
    cid = condo.id,
  ) {
    return app.inject({
      method: 'POST',
      url: `/v1/condominiums/${cid}/invites`,
      payload: { unit_id: condo.unitId, unit_relation: 'owner', can_list_spots: true, ...body },
      headers,
    });
  }

  /** Cria o convite e devolve o token tirado do fragmento do link. */
  async function inviteToken(body: Record<string, unknown> = {}) {
    const res = await createInvite(body);
    expect(res.statusCode).toBe(201);
    const url: string = res.json().invite_url;
    return { id: res.json().id as string, token: url.split('#token=')[1]! };
  }

  function lookup(token: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/public/invites/lookup',
      payload: { token },
      remoteAddress: newIp(),
    });
  }

  function accept(token: string, overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: '/v1/public/invites/accept',
      payload: {
        token,
        name: 'Carla Souza',
        email: 'carla@example.com',
        phone: '67 99999-4321',
        password: 'senha-da-carla',
        ...overrides,
      },
      remoteAddress: newIp(),
    });
  }

  async function membershipOf(email: string) {
    return app.db
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['m.status', 'm.unit_id', 'm.unit_relation', 'm.can_list_spots', 'm.origin'])
      .where('u.email', '=', email)
      .execute();
  }

  describe('síndico gera, lista e revoga', () => {
    it('gera convite com link no fragmento e validade da configuração (padrão 7 dias)', async () => {
      const res = await createInvite();

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.invite_url).toMatch(/\/convite#token=[A-Za-z0-9_-]{43}$/);
      expect(body).toMatchObject({
        status: 'pending',
        unit: { id: condo.unitId, number: '101', block: { name: 'Bloco A' } },
        unit_relation: 'owner',
        can_list_spots: true,
        used_by: null,
      });
      const days = (new Date(body.expires_at).getTime() - Date.now()) / DAY_MS;
      // Relógios do banco e do Node diferem em milissegundos: compara com folga.
      expect(days).toBeCloseTo(7, 3);

      const token = body.invite_url.split('#token=')[1];
      const stored = await app.db.selectFrom('invites').select('token_hash').execute();
      expect(stored[0]!.token_hash.toString('base64url')).not.toBe(token);
    });

    it('validade segue a configuração do condomínio', async () => {
      await app.db
        .updateTable('condominiums')
        .set({ invite_validity_days: 15 })
        .where('id', '=', condo.id)
        .execute();

      const res = await createInvite();

      const days = (new Date(res.json().expires_at).getTime() - Date.now()) / DAY_MS;
      expect(days).toBeCloseTo(15, 3);
    });

    it('lista com situação e o link não volta', async () => {
      const used = await inviteToken();
      await accept(used.token);
      const revoked = await inviteToken();
      await app.inject({
        method: 'POST',
        url: `/v1/condominiums/${condo.id}/invites/${revoked.id}/revoke`,
        headers: managerHeaders,
      });
      const expired = await inviteToken();
      await app.db
        .updateTable('invites')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('id', '=', expired.id)
        .execute();
      const pending = await inviteToken();

      const res = await app.inject({
        url: `/v1/condominiums/${condo.id}/invites`,
        headers: managerHeaders,
      });

      const byId = Object.fromEntries(
        res.json().items.map((i: { id: string; status: string }) => [i.id, i]),
      );
      expect(byId[used.id]).toMatchObject({ status: 'used', used_by: { name: 'Carla Souza' } });
      expect(byId[revoked.id].status).toBe('revoked');
      expect(byId[expired.id].status).toBe('expired');
      expect(byId[pending.id].status).toBe('pending');
      expect(JSON.stringify(res.json())).not.toContain('invite_url');
    });

    it('inquilino podendo anunciar com a regra desligada é recusado', async () => {
      await app.db
        .updateTable('condominiums')
        .set({ tenants_can_list_spots: false })
        .where('id', '=', condo.id)
        .execute();

      const res = await createInvite({ unit_relation: 'tenant', can_list_spots: true });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('TENANTS_CANNOT_LIST_SPOTS');
    });

    it('revogar convite usado ou já revogado → 409', async () => {
      const { id, token } = await inviteToken();
      await accept(token);
      const url = `/v1/condominiums/${condo.id}/invites/${id}/revoke`;

      const res = await app.inject({ method: 'POST', url, headers: managerHeaders });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('INVITE_NOT_REVOCABLE');
    });

    it('unidade ou convite de outro condomínio → 404; morador não gera convite', async () => {
      const other = await createCondominium(app);
      const foreignUnit = await createInvite({ unit_id: other.unitId });
      expect(foreignUnit.json().error.code).toBe('UNIT_NOT_FOUND');

      const otherManager = await createMember(app, other, { role: 'manager' });
      const otherHeaders = (await signIn(app, otherManager.user.id)).headers;
      const foreign = await app.inject({
        method: 'POST',
        url: `/v1/condominiums/${other.id}/invites`,
        payload: { unit_id: other.unitId, unit_relation: 'owner', can_list_spots: false },
        headers: otherHeaders,
      });
      const revoke = await app.inject({
        method: 'POST',
        url: `/v1/condominiums/${condo.id}/invites/${foreign.json().id}/revoke`,
        headers: managerHeaders,
      });
      expect(revoke.json().error.code).toBe('INVITE_NOT_FOUND');
      const list = await app.inject({
        url: `/v1/condominiums/${condo.id}/invites`,
        headers: managerHeaders,
      });
      expect(list.json().items).toEqual([]);

      const resident = await createMember(app, condo);
      const res = await createInvite({}, (await signIn(app, resident.user.id)).headers);
      expect(res.statusCode).toBe(403);
    });
  });

  describe('condômino abre e aceita', () => {
    it('lookup mostra condomínio e unidade', async () => {
      const { token } = await inviteToken();

      const res = await lookup(token);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        condominium: { name: expect.stringMatching(/^Residencial /) },
        unit: { number: '101', block: { name: 'Bloco A' } },
        unit_relation: 'owner',
      });
    });

    it('convite aceito cria conta com vínculo aprovado na unidade certa', async () => {
      const { token } = await inviteToken();

      const res = await accept(token);

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ status: 'approved', condominium: { id: condo.id } });
      expect(await membershipOf('carla@example.com')).toEqual([
        {
          status: 'approved',
          unit_id: condo.unitId,
          unit_relation: 'owner',
          can_list_spots: true,
          origin: 'invite',
        },
      ]);

      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'carla@example.com', password: 'senha-da-carla', client: 'mobile' },
        remoteAddress: newIp(),
      });
      const condoRes = await app.inject({
        url: `/v1/condominiums/${condo.id}`,
        headers: { authorization: `Bearer ${login.json().access_token}` },
      });
      expect(condoRes.statusCode).toBe(200);
    });

    it('segundo uso é recusado', async () => {
      const { token } = await inviteToken();
      await accept(token);

      const again = await accept(token, { email: 'outra@example.com' });

      expect(again.statusCode).toBe(410);
      expect(again.json().error.code).toBe('INVITE_USED');
      expect(await membershipOf('outra@example.com')).toEqual([]);
      expect((await lookup(token)).json().error.code).toBe('INVITE_USED');
    });

    it('duas aceitações simultâneas: só uma vence e a outra não deixa conta criada', async () => {
      const { token } = await inviteToken();

      const results = await Promise.all([
        accept(token, { email: 'a@example.com' }),
        accept(token, { email: 'b@example.com' }),
        accept(token, { email: 'c@example.com' }),
      ]);

      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 410, 410]);
      const users = await app.db
        .selectFrom('users')
        .select('email')
        .where('email', 'in', ['a@example.com', 'b@example.com', 'c@example.com'])
        .execute();
      expect(users).toHaveLength(1);
    });

    it('expirado e revogado são recusados com o motivo', async () => {
      const expired = await inviteToken();
      await app.db
        .updateTable('invites')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('id', '=', expired.id)
        .execute();
      const revoked = await inviteToken();
      await app.inject({
        method: 'POST',
        url: `/v1/condominiums/${condo.id}/invites/${revoked.id}/revoke`,
        headers: managerHeaders,
      });

      for (const [invite, code] of [
        [expired, 'INVITE_EXPIRED'],
        [revoked, 'INVITE_REVOKED'],
      ] as const) {
        const res = await accept(invite.token);
        expect(res.statusCode).toBe(410);
        expect(res.json().error).toMatchObject({
          code,
          message: expect.stringContaining('Peça um novo convite ao síndico'),
        });
        expect((await lookup(invite.token)).json().error.code).toBe(code);
      }
      expect(await membershipOf('carla@example.com')).toEqual([]);
    });

    it('token desconhecido → 404', async () => {
      const res = await lookup('x'.repeat(43));
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('INVITE_NOT_FOUND');
    });

    it('regra de inquilinos desligada depois do convite: entra sem poder anunciar', async () => {
      const { token } = await inviteToken({ unit_relation: 'tenant', can_list_spots: true });
      await app.db
        .updateTable('condominiums')
        .set({ tenants_can_list_spots: false })
        .where('id', '=', condo.id)
        .execute();

      await accept(token);

      expect(await membershipOf('carla@example.com')).toMatchObject([
        { status: 'approved', can_list_spots: false },
      ]);
    });

    it('e-mail já cadastrado → 409 e o convite continua valendo', async () => {
      const { token } = await inviteToken();
      const existing = await createMember(app, await createCondominium(app));

      const res = await accept(token, { email: existing.user.email });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('EMAIL_ALREADY_REGISTERED');
      expect((await lookup(token)).statusCode).toBe(200);
    });
  });

  describe('quem já tem conta aceita logado', () => {
    it('morador de outro condomínio entra aprovado com a mesma conta', async () => {
      const { token } = await inviteToken();
      const resident = await createMember(app, await createCondominium(app));
      const headers = (await signIn(app, resident.user.id)).headers;

      const res = await app.inject({
        method: 'POST',
        url: '/v1/me/invites/accept',
        payload: { token },
        headers,
      });

      expect(res.statusCode).toBe(201);
      const me = await app.inject({ url: '/v1/me', headers });
      expect(me.json().memberships.map((m: { status: string }) => m.status)).toEqual([
        'approved',
        'approved',
      ]);
    });

    it('três contas aceitando ao mesmo tempo: só uma entra (sem conferência prévia)', async () => {
      const { token } = await inviteToken();
      const other = await createCondominium(app);
      const people = await Promise.all([1, 2, 3].map(() => createMember(app, other)));
      const headers = await Promise.all(
        people.map(async (p) => (await signIn(app, p.user.id)).headers),
      );

      const results = await Promise.all(
        headers.map((h) =>
          app.inject({
            method: 'POST',
            url: '/v1/me/invites/accept',
            payload: { token },
            headers: h,
          }),
        ),
      );

      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 410, 410]);
      const joined = await app.db
        .selectFrom('memberships')
        .select('id')
        .where('condominium_id', '=', condo.id)
        .where('origin', '=', 'invite')
        .execute();
      expect(joined).toHaveLength(1);
    });

    it('quem já tem vínculo no condomínio → 409 e o convite continua valendo', async () => {
      const { token } = await inviteToken();
      const resident = await createMember(app, condo);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/me/invites/accept',
        payload: { token },
        headers: (await signIn(app, resident.user.id)).headers,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('ALREADY_MEMBER');
      expect((await lookup(token)).statusCode).toBe(200);
    });
  });

  /** Req. 11 (T19): a plataforma envia o convite por e-mail. */
  describe('envio pela plataforma', () => {
    beforeEach(() => {
      sentNotifications(app).length = 0;
    });

    function send(id: string, body: Record<string, unknown>, headers = managerHeaders) {
      return app.inject({
        method: 'POST',
        url: `/v1/condominiums/${condo.id}/invites/${id}/send`,
        payload: body,
        headers,
      });
    }

    const toCarla = { channel: 'email', recipient: { name: 'Carla', email: 'carla@example.com' } };

    it('envia por e-mail com um link novo; o link anterior deixa de valer', async () => {
      const { id, token: oldToken } = await inviteToken();

      const res = await send(id, toCarla);

      expect(res.statusCode).toBe(200);
      const newUrl: string = res.json().invite_url;
      expect(res.json()).toMatchObject({ status: 'pending', recipient_email: 'carla@example.com' });
      expect(sentNotifications(app)).toEqual([
        expect.objectContaining({
          type: 'invite',
          to: { name: 'Carla', email: 'carla@example.com' },
          inviteUrl: newUrl,
          condominiumName: expect.stringMatching(/^Residencial /),
        }),
      ]);
      expect((await lookup(oldToken)).json().error.code).toBe('INVITE_NOT_FOUND');
      expect((await lookup(newUrl.split('#token=')[1]!)).statusCode).toBe(200);
    });

    it('whatsapp responde indisponível e não troca o link', async () => {
      const { id, token } = await inviteToken();

      const res = await send(id, {
        channel: 'whatsapp',
        recipient: { name: 'Carla', phone: '67999990000' },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('CHANNEL_UNAVAILABLE');
      expect(sentNotifications(app)).toEqual([]);
      expect((await lookup(token)).statusCode).toBe(200);
    });

    it('e-mail sem destinatário → 400; convite usado ou vencido → 409', async () => {
      const { id } = await inviteToken();
      const noEmail = await send(id, { channel: 'email', recipient: { name: 'Carla' } });
      expect(noEmail.json().error.code).toBe('RECIPIENT_EMAIL_REQUIRED');

      const used = await inviteToken();
      await accept(used.token);
      const expired = await inviteToken();
      await app.db
        .updateTable('invites')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('id', '=', expired.id)
        .execute();
      for (const invite of [used, expired]) {
        const res = await send(invite.id, toCarla);
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('INVITE_NOT_SENDABLE');
      }
      expect(sentNotifications(app)).toEqual([]);
    });

    it('falha do fornecedor → 502 com mensagem que orienta', async () => {
      const { id } = await inviteToken();
      const spy = vi.spyOn(app.notifier, 'send').mockRejectedValueOnce(new Error('fora do ar'));

      const res = await send(id, toCarla);

      spy.mockRestore();
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toEqual({
        code: 'INVITE_SEND_FAILED',
        message: expect.stringContaining('compartilhe o link'),
      });
    });

    it('convite de outro condomínio → 404; morador não envia', async () => {
      const other = await createCondominium(app);
      const otherManager = await createMember(app, other, { role: 'manager' });
      const foreign = await app.inject({
        method: 'POST',
        url: `/v1/condominiums/${other.id}/invites`,
        payload: { unit_id: other.unitId, unit_relation: 'owner', can_list_spots: false },
        headers: (await signIn(app, otherManager.user.id)).headers,
      });

      const res = await send(foreign.json().id, toCarla);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('INVITE_NOT_FOUND');

      const { id } = await inviteToken();
      const resident = await createMember(app, condo);
      const denied = await send(id, toCarla, (await signIn(app, resident.user.id)).headers);
      expect(denied.statusCode).toBe(403);
      expect(sentNotifications(app)).toEqual([]);
    });
  });
});
