import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvents } from '../../src/plugins/app/events.ts';
import type { Notification } from '../../src/plugins/app/notifications/messages.ts';
import { createUser, signIn } from '../fixtures.ts';
import { buildTestApp, sentNotifications } from '../helper.ts';
import { resetDatabase } from '../test-database.ts';

/**
 * Critérios de aceite da spec 001 (vagou-specs/specs/001-onboarding-acesso/spec.md), lado
 * API, um `describe` por cenário. Tudo passa pelas rotas, como um cliente faria: login com
 * senha, links tirados dos e-mails. Atalhos pelo banco só onde a spec fala de tempo
 * (convite vencido) e para criar o admin (que na vida real vem de `npm run admin:criar`).
 */
describe('spec 001: critérios de aceite', () => {
  let app: FastifyInstance;
  let ip = 0;
  type Headers = Record<string, string>;
  let admin: Headers | undefined;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    sentNotifications(app).length = 0;
    admin = undefined;
  });

  /** Cada chamada com IP próprio, para o rate limit das rotas públicas não interferir. */
  function api(
    method: InjectOptions['method'],
    url: string,
    options: { payload?: object; headers?: Headers } = {},
  ) {
    ip += 1;
    return app.inject({
      method,
      url,
      payload: options.payload,
      headers: options.headers,
      remoteAddress: `10.22.${Math.floor(ip / 250)}.${ip % 250}`,
    });
  }

  /** O e-mail que a pessoa recebeu (os avisos não são aguardados pela API). */
  async function mailTo<T extends Notification['type']>(type: T, email: string) {
    return vi.waitFor(() => {
      const found = sentNotifications(app).find((n) => n.type === type && n.to.email === email);
      if (!found) throw new Error(`${type} para ${email} não enviado`);
      return found as Extract<Notification, { type: T }>;
    });
  }

  /** O web lê o token do fragmento do link (`#token=...`). */
  function tokenFrom(url: string) {
    const token = new URL(url).hash.replace('#token=', '');
    expect(token.length).toBeGreaterThan(20);
    return token;
  }

  async function login(email: string, password: string): Promise<Headers> {
    const res = await api('POST', '/v1/auth/login', {
      payload: { email, password, client: 'mobile' },
    });
    expect(res.statusCode).toBe(200);
    return { authorization: `Bearer ${res.json().access_token}` };
  }

  async function me(headers: Headers) {
    const res = await api('GET', '/v1/me', { headers });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      memberships: {
        id: string;
        role: string;
        status: string;
        can_list_spots: boolean;
        condominium: { id: string; name: string };
        unit: { number: string; block: { name: string } } | null;
      }[];
    };
  }

  /** O admin da plataforma (um por teste). */
  async function adminHeaders() {
    if (!admin) {
      const user = await createUser(app, { email: 'admin@vagou.app' });
      await app.db.updateTable('users').set({ is_admin: true }).where('id', '=', user.id).execute();
      admin = (await signIn(app, user.id)).headers;
    }
    return admin;
  }

  /**
   * Cenário 1 inteiro: o admin cadastra o condomínio e o síndico; o síndico define a senha
   * pelo link do e-mail, entra e cadastra o bloco 2 com a unidade 101.
   */
  async function setUpCondominium(name: string, manager: { name: string; email: string }) {
    const created = await api('POST', '/v1/admin/condominiums', {
      headers: await adminHeaders(),
      payload: { name, address: 'Rua das Flores, 100', manager },
    });
    expect(created.statusCode).toBe(201);
    const condominium = created.json() as { id: string; public_code: string };

    const mail = await mailTo('manager_account_created', manager.email);
    const password = `senha-de-${manager.name.toLowerCase()}`;
    const set = await api('POST', '/v1/auth/reset-password', {
      payload: { token: tokenFrom(mail.setPasswordUrl!), password },
    });
    expect(set.statusCode).toBe(204);
    const managerHeaders = await login(manager.email, password);

    const block = await api('POST', `/v1/condominiums/${condominium.id}/blocks`, {
      headers: managerHeaders,
      payload: { name: 'Bloco 2' },
    });
    expect(block.statusCode).toBe(201);
    const unit = await api('POST', `/v1/condominiums/${condominium.id}/units`, {
      headers: managerHeaders,
      payload: { block_id: block.json().id, number: '101' },
    });
    expect(unit.statusCode).toBe(201);

    return {
      id: condominium.id,
      publicCode: condominium.public_code,
      managerHeaders,
      unitId: unit.json().id as string,
    };
  }

  type Condo = Awaited<ReturnType<typeof setUpCondominium>>;
  const person = (name: string) => ({
    name,
    email: `${name.toLowerCase()}@example.com`,
    phone: '(67) 99999-0000',
    password: `senha-de-${name.toLowerCase()}`,
  });

  /** Gera um convite (síndico) e devolve o token do link. */
  async function invite(condo: Condo, relation: 'owner' | 'tenant' = 'owner') {
    const res = await api('POST', `/v1/condominiums/${condo.id}/invites`, {
      headers: condo.managerHeaders,
      payload: { unit_id: condo.unitId, unit_relation: relation, can_list_spots: false },
    });
    expect(res.statusCode).toBe(201);
    return { id: res.json().id as string, token: tokenFrom(res.json().invite_url) };
  }

  function acceptInvite(token: string, who: ReturnType<typeof person>) {
    return api('POST', '/v1/public/invites/accept', { payload: { token, ...who } });
  }

  /** Morador aprovado por convite, já logado. */
  async function residentByInvite(condo: Condo, name: string) {
    const who = person(name);
    expect((await acceptInvite((await invite(condo)).token, who)).statusCode).toBe(201);
    const headers = await login(who.email, who.password);
    const membership = (await me(headers)).memberships[0]!;
    return { headers, membershipId: membership.id };
  }

  function signupByQrCode(condo: Condo, who: ReturnType<typeof person>, relation = 'owner') {
    return api('POST', `/v1/public/condominiums/${condo.publicCode}/signup`, {
      payload: { ...who, unit_id: condo.unitId, unit_relation: relation },
    });
  }

  describe('admin cadastra condomínio e síndico', () => {
    it('Maria recebe acesso e consegue cadastrar blocos e unidades', async () => {
      const condo = await setUpCondominium('Residencial A', person('Maria'));

      const [membership] = (await me(condo.managerHeaders)).memberships;
      expect(membership).toMatchObject({
        role: 'manager',
        status: 'approved',
        condominium: { name: 'Residencial A' },
      });
      const blocks = await api('GET', `/v1/condominiums/${condo.id}/blocks`, {
        headers: condo.managerHeaders,
      });
      expect(blocks.json().items).toMatchObject([
        { name: 'Bloco 2', units: [{ id: condo.unitId, number: '101' }] },
      ]);
    });
  });

  describe('cadastro pelo QR Code', () => {
    it('vínculo pendente, síndico avisado, morador sem acesso ao condomínio', async () => {
      const condo = await setUpCondominium('Residencial A', person('Maria'));
      const carlos = person('Carlos');

      // O link do QR Code mostra o condomínio, os blocos e as unidades.
      const page = await api('GET', `/v1/public/condominiums/${condo.publicCode}`);
      expect(page.statusCode).toBe(200);
      expect(page.json()).toMatchObject({
        name: 'Residencial A',
        blocks: [{ name: 'Bloco 2', units: [{ id: condo.unitId, number: '101' }] }],
      });

      const res = await signupByQrCode(condo, carlos);
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe('pending');

      const mail = await mailTo('membership_pending', 'maria@example.com');
      expect(mail).toMatchObject({
        condominiumName: 'Residencial A',
        residentName: 'Carlos',
        unitLabel: 'Bloco 2, unidade 101',
      });

      // Tela "aguardando aprovação": o web decide pelo status do vínculo em /v1/me.
      const headers = await login(carlos.email, carlos.password);
      expect((await me(headers)).memberships).toMatchObject([
        { status: 'pending', can_list_spots: false, condominium: { name: 'Residencial A' } },
      ]);
      const condoRes = await api('GET', `/v1/condominiums/${condo.id}`, { headers });
      expect(condoRes.statusCode).toBe(403);
    });
  });

  describe('cadastro por convite', () => {
    it('conta criada já vinculada ao bloco 2, unidade 101 e aprovada', async () => {
      const condo = await setUpCondominium('Residencial A', person('Maria'));
      const { token } = await invite(condo);
      const carla = person('Carla');

      const lookup = await api('POST', '/v1/public/invites/lookup', { payload: { token } });
      expect(lookup.json()).toMatchObject({
        condominium: { name: 'Residencial A' },
        unit: { number: '101', block: { name: 'Bloco 2' } },
      });

      const res = await acceptInvite(token, carla);
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe('approved');

      const headers = await login(carla.email, carla.password);
      expect((await me(headers)).memberships).toMatchObject([
        { status: 'approved', unit: { number: '101', block: { name: 'Bloco 2' } } },
      ]);
      expect((await api('GET', `/v1/condominiums/${condo.id}`, { headers })).statusCode).toBe(200);
      // Sem passar pelo síndico: ninguém foi avisado para aprovar.
      expect(sentNotifications(app).some((n) => n.type === 'membership_pending')).toBe(false);
    });
  });

  describe('convite já usado', () => {
    it('outra pessoa tenta usar o mesmo convite → recusado', async () => {
      const condo = await setUpCondominium('Residencial A', person('Maria'));
      const { token } = await invite(condo);
      expect((await acceptInvite(token, person('Carla'))).statusCode).toBe(201);

      const res = await acceptInvite(token, person('Pedro'));

      expect(res.statusCode).toBe(410);
      expect(res.json().error.code).toBe('INVITE_USED');
      const pedro = await app.db
        .selectFrom('users')
        .select('id')
        .where('email', '=', 'pedro@example.com')
        .executeTakeFirst();
      expect(pedro).toBeUndefined();
    });
  });

  describe('convite expirado ou revogado', () => {
    it('recusado com a orientação de pedir um novo convite ao síndico', async () => {
      const condo = await setUpCondominium('Residencial A', person('Maria'));

      // Validade padrão de 7 dias; o tempo passa (atalho pelo banco).
      const expired = await invite(condo);
      const validity = await app.db
        .selectFrom('invites')
        .select(['created_at', 'expires_at'])
        .where('id', '=', expired.id)
        .executeTakeFirstOrThrow();
      const days = (validity.expires_at.getTime() - validity.created_at.getTime()) / 86_400_000;
      expect(days).toBeCloseTo(7, 3);
      await app.db
        .updateTable('invites')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('id', '=', expired.id)
        .execute();

      const revoked = await invite(condo);
      const revoke = await api(
        'POST',
        `/v1/condominiums/${condo.id}/invites/${revoked.id}/revoke`,
        { headers: condo.managerHeaders },
      );
      expect(revoke.statusCode).toBe(204);

      for (const [token, code] of [
        [expired.token, 'INVITE_EXPIRED'],
        [revoked.token, 'INVITE_REVOKED'],
      ] as const) {
        const res = await acceptInvite(token, person('Carla'));
        expect(res.statusCode).toBe(410);
        expect(res.json().error).toMatchObject({
          code,
          message: expect.stringContaining('Peça um novo convite ao síndico'),
        });
      }
    });
  });

  describe('inquilino em condomínio que não permite anúncio por inquilinos', () => {
    it('o síndico não consegue marcar o inquilino como "pode anunciar"', async () => {
      const condo = await setUpCondominium('Residencial A', person('Maria'));
      const rule = await api('PATCH', `/v1/condominiums/${condo.id}`, {
        headers: condo.managerHeaders,
        payload: { tenants_can_list_spots: false },
      });
      expect(rule.statusCode).toBe(200);
      const signup = await signupByQrCode(condo, person('Tiago'), 'tenant');
      const membershipId = signup.json().membership_id as string;
      const path = `/v1/condominiums/${condo.id}/memberships/${membershipId}`;

      const withSpots = await api('POST', `${path}/approve`, {
        headers: condo.managerHeaders,
        payload: { can_list_spots: true },
      });
      expect(withSpots.statusCode).toBe(409);
      expect(withSpots.json().error.code).toBe('TENANTS_CANNOT_LIST_SPOTS');

      const approve = await api('POST', `${path}/approve`, {
        headers: condo.managerHeaders,
        payload: { can_list_spots: false },
      });
      expect(approve.statusCode).toBe(204);
      const later = await api('PATCH', path, {
        headers: condo.managerHeaders,
        payload: { can_list_spots: true },
      });
      expect(later.statusCode).toBe(409);
      expect(later.json().error.code).toBe('TENANTS_CANNOT_LIST_SPOTS');

      // Convite também não passa por cima da regra.
      const inviteRes = await api('POST', `/v1/condominiums/${condo.id}/invites`, {
        headers: condo.managerHeaders,
        payload: { unit_id: condo.unitId, unit_relation: 'tenant', can_list_spots: true },
      });
      expect(inviteRes.statusCode).toBe(409);
    });
  });

  describe('troca de síndico', () => {
    /**
     * Maria mora no prédio (entrou por convite) e foi feita síndica pelo admin. O caso do
     * síndico cadastrado pelo admin, sem unidade, está no último teste (T23).
     */
    async function scenario() {
      const condo = await setUpCondominium('Residencial A', person('Ana'));
      const maria = await residentByInvite(condo, 'Maria');
      const joao = await residentByInvite(condo, 'Joao');
      const toMaria = await api('POST', `/v1/admin/condominiums/${condo.id}/manager`, {
        headers: await adminHeaders(),
        payload: { email: 'maria@example.com' },
      });
      expect(toMaria.statusCode).toBe(200);
      return { condo, maria, joao };
    }

    async function expectSwapped(
      condo: Condo,
      maria: { headers: Headers },
      joao: { headers: Headers },
    ) {
      expect((await me(joao.headers)).memberships[0]).toMatchObject({ role: 'manager' });
      const joaoList = await api('GET', `/v1/condominiums/${condo.id}/memberships`, {
        headers: joao.headers,
      });
      expect(joaoList.statusCode).toBe(200);

      expect((await me(maria.headers)).memberships[0]).toMatchObject({
        role: 'resident',
        status: 'approved',
        unit: { number: '101' },
      });
      const mariaList = await api('GET', `/v1/condominiums/${condo.id}/memberships`, {
        headers: maria.headers,
      });
      expect(mariaList.statusCode).toBe(403);
      expect((await api('GET', `/v1/condominiums/${condo.id}`, maria)).statusCode).toBe(200);
    }

    it('Maria passa o papel para João e continua moradora', async () => {
      const { condo, maria, joao } = await scenario();

      const res = await api('POST', `/v1/condominiums/${condo.id}/manager`, {
        headers: maria.headers,
        payload: { membership_id: joao.membershipId },
      });

      expect(res.statusCode).toBe(200);
      await expectSwapped(condo, maria, joao);
      await mailTo('manager_role_received', 'joao@example.com');
    });

    it('o admin passa o papel de Maria para João', async () => {
      const { condo, maria, joao } = await scenario();

      const res = await api('POST', `/v1/admin/condominiums/${condo.id}/manager`, {
        headers: await adminHeaders(),
        payload: { email: 'joao@example.com' },
      });

      expect(res.statusCode).toBe(200);
      await expectSwapped(condo, maria, joao);
    });

    it('síndica cadastrada pelo admin informa a unidade, passa o papel e continua moradora', async () => {
      const condo = await setUpCondominium('Residencial A', person('Maria'));
      const joao = await residentByInvite(condo, 'Joao');
      const maria = { headers: condo.managerHeaders };

      const unit = await api('PATCH', `/v1/condominiums/${condo.id}/memberships/me`, {
        headers: maria.headers,
        payload: { unit_id: condo.unitId, unit_relation: 'owner' },
      });
      expect(unit.statusCode).toBe(204);
      const res = await api('POST', `/v1/condominiums/${condo.id}/manager`, {
        headers: maria.headers,
        payload: { membership_id: joao.membershipId },
      });

      expect(res.statusCode).toBe(200);
      await expectSwapped(condo, maria, joao);
    });
  });

  describe('isolamento entre condomínios', () => {
    it('morador do A não acessa nada do B, nem alterando a URL', async () => {
      const a = await setUpCondominium('Residencial A', person('Maria'));
      const b = await setUpCondominium('Residencial B', person('Beatriz'));
      const carla = await residentByInvite(a, 'Carla');
      const bResident = await residentByInvite(b, 'Bruno');

      const attempts = [
        api('GET', `/v1/condominiums/${b.id}`, carla),
        api('GET', `/v1/condominiums/${b.id}/blocks`, carla),
        api('GET', `/v1/condominiums/${b.id}/memberships`, carla),
        api('GET', `/v1/condominiums/${b.id}/invites`, carla),
        // O síndico do A tentando agir no B, direto ou pelo próprio :cid.
        api('GET', `/v1/condominiums/${b.id}/memberships`, { headers: a.managerHeaders }),
        api('POST', `/v1/condominiums/${a.id}/memberships/${bResident.membershipId}/remove`, {
          headers: a.managerHeaders,
        }),
        api('PATCH', `/v1/condominiums/${a.id}/units/${b.unitId}`, {
          headers: a.managerHeaders,
          payload: { number: '999' },
        }),
      ];

      for (const res of await Promise.all(attempts)) {
        expect(res.statusCode).toBe(404);
        expect(res.body).not.toContain('Residencial B');
        expect(res.body).not.toContain(b.id);
      }
      expect((await me(bResident.headers)).memberships[0]).toMatchObject({ status: 'approved' });
    });
  });

  describe('remoção de morador', () => {
    let removed: AppEvents['membership.removed'][];
    let off: () => void;

    beforeEach(() => {
      removed = [];
      off = app.events.on('membership.removed', async (event) => {
        removed.push(event);
      });
    });

    afterEach(() => off());

    it('o próximo acesso dele é bloqueado e o evento para vagas e reservas é emitido', async () => {
      const condo = await setUpCondominium('Residencial A', person('Maria'));
      const carla = await residentByInvite(condo, 'Carla');
      expect((await api('GET', `/v1/condominiums/${condo.id}`, carla)).statusCode).toBe(200);

      const res = await api(
        'POST',
        `/v1/condominiums/${condo.id}/memberships/${carla.membershipId}/remove`,
        { headers: condo.managerHeaders },
      );

      expect(res.statusCode).toBe(204);
      expect((await api('GET', `/v1/condominiums/${condo.id}`, carla)).statusCode).toBe(401);
      const relogin = await api('POST', '/v1/auth/login', {
        payload: { email: 'carla@example.com', password: 'senha-de-carla', client: 'mobile' },
      });
      const headers = { authorization: `Bearer ${relogin.json().access_token}` };
      expect((await me(headers)).memberships).toEqual([]);
      expect((await api('GET', `/v1/condominiums/${condo.id}`, { headers })).statusCode).toBe(404);
      // "A vaga some da busca" e "a reserva é cancelada com estorno" são dos planos 002 e
      // 006, que consomem este evento.
      expect(removed).toEqual([expect.objectContaining({ membershipId: carla.membershipId })]);
    });
  });

  describe('recuperação de senha', () => {
    /** O tempo passa (atalho pelo banco): links vencidos e pedidos fora da espera de 60 s. */
    async function moveResetsBack(minutes: number) {
      await app.db
        .updateTable('password_resets')
        .set((eb) => ({
          created_at: sql`${eb.ref('created_at')} - make_interval(mins => ${minutes})`,
          expires_at: sql`${eb.ref('expires_at')} - make_interval(mins => ${minutes})`,
        }))
        .execute();
    }

    async function resetMail(email: string, nth: number) {
      return vi.waitFor(() => {
        const mails = sentNotifications(app).filter(
          (n) => n.type === 'password_reset' && n.to.email === email,
        );
        if (mails.length < nth) throw new Error(`e-mail ${nth} não enviado`);
        return mails[nth - 1] as Extract<Notification, { type: 'password_reset' }>;
      });
    }

    function reset(token: string, password: string) {
      return api('POST', '/v1/auth/reset-password', { payload: { token, password } });
    }

    it('link de uso único e com validade; resposta igual para e-mail inexistente', async () => {
      const condo = await setUpCondominium('Residencial A', person('Maria'));
      await residentByInvite(condo, 'Carla');

      const existing = await api('POST', '/v1/auth/forgot-password', {
        payload: { email: 'carla@example.com' },
      });
      const missing = await api('POST', '/v1/auth/forgot-password', {
        payload: { email: 'ninguem@example.com' },
      });
      expect(missing.statusCode).toBe(existing.statusCode);
      expect(missing.body).toBe(existing.body);
      const first = await resetMail('carla@example.com', 1);
      expect(first.expiresInMinutes).toBeGreaterThan(0);
      expect(sentNotifications(app).filter((n) => n.type === 'password_reset')).toHaveLength(1);

      // Validade: passado o prazo, o link é recusado.
      await moveResetsBack(first.expiresInMinutes + 1);
      const late = await reset(tokenFrom(first.resetUrl), 'senha-nova-da-carla');
      expect(late.statusCode).toBe(400);
      expect(late.json().error.code).toBe('INVALID_RESET_TOKEN');

      // Novo pedido: o link funciona uma vez só.
      await api('POST', '/v1/auth/forgot-password', { payload: { email: 'carla@example.com' } });
      const token = tokenFrom((await resetMail('carla@example.com', 2)).resetUrl);
      expect((await reset(token, 'senha-nova-da-carla')).statusCode).toBe(204);
      await login('carla@example.com', 'senha-nova-da-carla');

      const again = await reset(token, 'outra-senha-qualquer');
      expect(again.statusCode).toBe(400);
      expect(again.json().error.code).toBe('INVALID_RESET_TOKEN');
    });
  });
});
