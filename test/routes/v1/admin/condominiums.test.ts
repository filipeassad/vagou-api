import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from '../../../../src/plugins/app/notifications/messages.ts';
import { createCondominium, createMember, createUser, signIn } from '../../../fixtures.ts';
import { buildTestApp, sentNotifications } from '../../../helper.ts';
import { resetDatabase } from '../../../test-database.ts';

type ManagerNotification = Extract<Notification, { type: 'manager_account_created' }>;

/** Spec 001, req. 1; plano 001, D11. */
describe('/v1/admin/condominiums', () => {
  let app: FastifyInstance;
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
    vi.restoreAllMocks();
  });

  async function adminHeaders() {
    const admin = await createUser(app);
    await app.db.updateTable('users').set({ is_admin: true }).where('id', '=', admin.id).execute();
    return (await signIn(app, admin.id)).headers;
  }

  const body = {
    name: 'Residencial Aurora',
    address: 'Rua das Flores, 100',
    manager: { name: 'Sônia Síndica', email: 'sonia@example.com', phone: '67999991111' },
  };

  function create(headers: Record<string, string>, payload: Record<string, unknown> = body) {
    return app.inject({ method: 'POST', url: '/v1/admin/condominiums', headers, payload });
  }

  function post(url: string, payload: Record<string, unknown>) {
    ipCounter += 1;
    return app.inject({ method: 'POST', url, payload, remoteAddress: `10.2.0.${ipCounter}` });
  }

  function lastManagerNotification(): ManagerNotification {
    return sentNotifications(app)
      .filter((n): n is ManagerNotification => n.type === 'manager_account_created')
      .at(-1)!;
  }

  it('admin cria condomínio e síndico; o síndico define a senha pelo link e entra', async () => {
    const headers = await adminHeaders();

    const res = await create(headers);

    expect(res.statusCode).toBe(201);
    const condominium = res.json();
    expect(condominium).toMatchObject({
      name: 'Residencial Aurora',
      address: 'Rua das Flores, 100',
      timezone: 'America/Sao_Paulo',
      public_code: expect.stringMatching(/^[2-9A-HJKMNP-Z]{8}$/),
      manager: { name: 'Sônia Síndica', email: 'sonia@example.com' },
    });

    const notification = lastManagerNotification();
    expect(notification).toMatchObject({
      to: { email: 'sonia@example.com' },
      condominiumName: 'Residencial Aurora',
    });
    const url = new URL(notification.setPasswordUrl!);
    expect(url.pathname).toBe('/definir-senha');
    const token = new URLSearchParams(url.hash.slice(1)).get('token')!;

    const setPassword = await post('/v1/auth/reset-password', {
      token,
      password: 'senha-da-sonia-1',
    });
    expect(setPassword.statusCode).toBe(204);

    const login = await post('/v1/auth/login', {
      email: 'sonia@example.com',
      password: 'senha-da-sonia-1',
    });
    expect(login.statusCode).toBe(200);

    // Já entra como síndico aprovado do condomínio novo.
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${login.json().access_token}` },
    });
    expect(me.json().memberships).toMatchObject([
      { role: 'manager', status: 'approved', unit: null, condominium: { id: condominium.id } },
    ]);
  });

  it('o link de definir senha vale 7 dias', async () => {
    await create(await adminHeaders());

    const { created_at, expires_at } = await app.db
      .selectFrom('password_resets')
      .select(['created_at', 'expires_at'])
      .executeTakeFirstOrThrow();
    expect((expires_at.getTime() - created_at.getTime()) / 86_400_000).toBeCloseTo(7, 5);
  });

  it('e-mail já cadastrado com senha: usa a conta existente e não manda link de senha', async () => {
    const headers = await adminHeaders();
    const existing = await app.usersRepository.create({
      name: 'Sônia',
      email: 'Sonia@Example.com',
      phone: null,
      passwordHash: await app.passwordManager.hash('senha-antiga-1'),
    });

    const res = await create(headers);

    expect(res.statusCode).toBe(201);
    expect(res.json().manager.id).toBe(existing.id);
    expect(lastManagerNotification().setPasswordUrl).toBeNull();
    expect(await app.db.selectFrom('password_resets').selectAll().execute()).toHaveLength(0);
  });

  it('lista os condomínios com o síndico de cada um', async () => {
    const headers = await adminHeaders();
    await create(headers, {
      ...body,
      name: 'Bosque Verde',
      manager: { ...body.manager, email: 'b@example.com' },
    });
    await create(headers);
    const withoutManager = await createCondominium(app);

    const res = await app.inject({ method: 'GET', url: '/v1/admin/condominiums', headers });

    expect(res.statusCode).toBe(200);
    const items = res.json().items as {
      id: string;
      name: string;
      created_at: string;
      manager: unknown;
    }[];
    expect(items).toHaveLength(3);
    expect(items[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(items.find((c) => c.name === 'Bosque Verde')?.manager).toMatchObject({
      email: 'b@example.com',
    });
    expect(items.find((c) => c.id === withoutManager.id)?.manager).toBeNull();
  });

  it('usuário comum, síndico e anônimo não acessam /v1/admin/*', async () => {
    const condominium = await createCondominium(app);
    const manager = await createMember(app, condominium, { role: 'manager' });
    const plain = await createUser(app);

    for (const headers of [
      (await signIn(app, plain.id)).headers,
      (await signIn(app, manager.user.id)).headers,
    ]) {
      const list = await app.inject({ method: 'GET', url: '/v1/admin/condominiums', headers });
      const created = await create(headers);
      expect(list.statusCode).toBe(403);
      expect(list.json().error.code).toBe('FORBIDDEN');
      expect(created.statusCode).toBe(403);
    }
    const anonymous = await app.inject({ method: 'GET', url: '/v1/admin/condominiums' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('fuso desconhecido é recusado sem criar nada', async () => {
    const res = await create(await adminHeaders(), { ...body, timezone: 'Marte/Olympus' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TIMEZONE');
    expect(await app.db.selectFrom('condominiums').selectAll().execute()).toHaveLength(0);
  });

  it('dados obrigatórios faltando → 400 VALIDATION_ERROR', async () => {
    const res = await create(await adminHeaders(), { name: 'Sem endereço' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('falha no envio do e-mail não desfaz o cadastro', async () => {
    const headers = await adminHeaders();
    vi.spyOn(app.notifier, 'send').mockRejectedValue(new Error('fornecedor fora do ar'));

    const res = await create(headers);

    expect(res.statusCode).toBe(201);
  });

  it('código do QR Code repetido: gera outro e o cadastro segue', async () => {
    const headers = await adminHeaders();
    const first = (await create(headers)).json();
    const original = app.condominiumsRepository.createWithManager;
    // A primeira tentativa usa o código já existente (colisão); as seguintes, o real.
    const spy = vi
      .spyOn(app.condominiumsRepository, 'createWithManager')
      .mockImplementationOnce((input) => original({ ...input, publicCode: first.public_code }));

    const res = await create(headers, { ...body, name: 'Bosque Verde' });

    expect(res.statusCode).toBe(201);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(res.json().public_code).not.toBe(first.public_code);
    expect(await app.db.selectFrom('condominiums').selectAll().execute()).toHaveLength(2);
  });
});
