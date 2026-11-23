import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashOpaqueToken } from '../../../../src/plugins/app/auth/opaque-token.ts';
import { createCondominium, createMember, createUser, signIn } from '../../../fixtures.ts';
import { buildTestApp } from '../../../helper.ts';
import { resetDatabase } from '../../../test-database.ts';

type Condo = Awaited<ReturnType<typeof createCondominium>>;

const DAY_MS = 24 * 60 * 60 * 1000;
const PASSWORD = 'portaria-2026';

/** Spec 001, req. 4; plano 001, D5 e D12: o síndico cria o acesso da portaria. */
describe('acesso da portaria', () => {
  let app: FastifyInstance;
  let condo: Condo;
  let manager: Record<string, string>;
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
    const member = await createMember(app, condo, { role: 'manager' });
    manager = (await signIn(app, member.user.id)).headers;
  });

  function setAccess(body: Record<string, unknown>, headers = manager, cid = condo.id) {
    return app.inject({
      method: 'PUT',
      url: `/v1/condominiums/${cid}/front-desk`,
      payload: body,
      headers,
    });
  }

  /** Login de verdade pela rota (IP próprio por chamada, longe do rate limit). */
  function login(email: string, password = PASSWORD) {
    ipCounter += 1;
    return app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password, client: 'mobile' },
      remoteAddress: `10.9.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`,
    });
  }

  const bearer = (res: { json(): { access_token: string } }) => ({
    authorization: `Bearer ${res.json().access_token}`,
  });

  it('síndico cria o acesso e a portaria entra com sessão de 30 dias', async () => {
    const res = await setAccess({ email: 'portaria@aurora.com', password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: 'portaria@aurora.com' });

    const shown = await app.inject({
      method: 'GET',
      url: `/v1/condominiums/${condo.id}/front-desk`,
      headers: manager,
    });
    expect(shown.json()).toEqual({ email: 'portaria@aurora.com' });

    const logged = await login('portaria@aurora.com');
    expect(logged.statusCode).toBe(200);
    const session = await app.db
      .selectFrom('sessions')
      .select('expires_at')
      .where('refresh_token_hash', '=', hashOpaqueToken(logged.json().refresh_token))
      .executeTakeFirstOrThrow();
    const days = (session.expires_at.getTime() - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(logged) });
    expect(me.json().memberships).toMatchObject([
      { role: 'front_desk', status: 'approved', unit: null, condominium: { id: condo.id } },
    ]);
  });

  it('sem acesso criado, o GET devolve email null', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/condominiums/${condo.id}/front-desk`,
      headers: manager,
    });
    expect(res.json()).toEqual({ email: null });
  });

  it('portaria recebe 403 nas rotas de morador e de síndico', async () => {
    await setAccess({ email: 'portaria@aurora.com', password: PASSWORD });
    const headers = bearer(await login('portaria@aurora.com'));
    const url = `/v1/condominiums/${condo.id}`;

    // Dados básicos do condomínio: liberado para qualquer vínculo aprovado.
    expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(200);

    const denied = [
      await app.inject({ method: 'PATCH', url, headers, payload: { name: 'X' } }),
      await app.inject({ method: 'GET', url: `${url}/blocks`, headers }),
      await app.inject({ method: 'GET', url: `${url}/front-desk`, headers }),
      await setAccess({ email: 'outra@aurora.com', password: PASSWORD }, headers),
    ];
    for (const res of denied) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
  });

  it('morador não cria o acesso', async () => {
    const resident = await createMember(app, condo);
    const res = await setAccess(
      { email: 'portaria@aurora.com', password: PASSWORD },
      (await signIn(app, resident.user.id)).headers,
    );
    expect(res.statusCode).toBe(403);
  });

  it('redefinir a senha derruba as sessões abertas da portaria', async () => {
    await setAccess({ email: 'portaria@aurora.com', password: PASSWORD });
    const old = await login('portaria@aurora.com');
    const url = `/v1/condominiums/${condo.id}`;
    expect((await app.inject({ method: 'GET', url, headers: bearer(old) })).statusCode).toBe(200);

    await setAccess({ email: 'portaria@aurora.com', password: 'nova-senha-123' });

    expect((await app.inject({ method: 'GET', url, headers: bearer(old) })).statusCode).toBe(401);
    expect((await login('portaria@aurora.com')).statusCode).toBe(401);
    expect((await login('portaria@aurora.com', 'nova-senha-123')).statusCode).toBe(200);
  });

  it('trocar o e-mail substitui o acesso: o anterior perde o vínculo e as sessões', async () => {
    await setAccess({ email: 'portaria@aurora.com', password: PASSWORD });
    const old = await login('portaria@aurora.com');

    const res = await setAccess({ email: 'guarita@aurora.com', password: PASSWORD });
    expect(res.json()).toEqual({ email: 'guarita@aurora.com' });

    const url = `/v1/condominiums/${condo.id}`;
    expect((await app.inject({ method: 'GET', url, headers: bearer(old) })).statusCode).toBe(401);
    const relogged = await login('portaria@aurora.com');
    expect((await app.inject({ method: 'GET', url, headers: bearer(relogged) })).statusCode).toBe(
      404,
    );
    const fresh = await login('guarita@aurora.com');
    expect((await app.inject({ method: 'GET', url, headers: bearer(fresh) })).statusCode).toBe(200);

    const active = await app.db
      .selectFrom('memberships')
      .select('id')
      .where('condominium_id', '=', condo.id)
      .where('role', '=', 'front_desk')
      .where('status', '=', 'approved')
      .execute();
    expect(active).toHaveLength(1);
  });

  it('o e-mail de uma portaria anterior deste condomínio pode voltar', async () => {
    await setAccess({ email: 'portaria@aurora.com', password: PASSWORD });
    await setAccess({ email: 'guarita@aurora.com', password: PASSWORD });

    const res = await setAccess({ email: 'Portaria@Aurora.com', password: 'de-volta-123' });

    expect(res.statusCode).toBe(200);
    expect((await login('portaria@aurora.com', 'de-volta-123')).statusCode).toBe(200);
  });

  it('e-mail de outra conta (morador, síndico, portaria de outro prédio) → 409', async () => {
    const resident = await createMember(app, condo);
    const other = await createCondominium(app);
    const otherDesk = await createMember(app, other, { role: 'front_desk' });
    const loose = await createUser(app, { email: 'sem-vinculo@example.com' });
    await app.db.updateTable('users').set({ is_admin: true }).where('id', '=', loose.id).execute();

    for (const email of [resident.user.email, otherDesk.user.email, loose.email]) {
      const res = await setAccess({ email, password: PASSWORD });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('FRONT_DESK_EMAIL_IN_USE');
    }
    const untouched = await app.db
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', resident.user.id)
      .executeTakeFirstOrThrow();
    expect(untouched.password_hash).toBeNull();
  });

  it('senha curta e e-mail inválido são recusados', async () => {
    expect((await setAccess({ email: 'p@aurora.com', password: 'curta' })).statusCode).toBe(400);
    expect((await setAccess({ email: 'portaria', password: PASSWORD })).statusCode).toBe(400);
  });

  it('síndico de outro condomínio não mexe na portaria deste (princípio I)', async () => {
    const other = await createCondominium(app);
    const otherManager = await createMember(app, other, { role: 'manager' });

    const res = await setAccess(
      { email: 'invasor@example.com', password: PASSWORD },
      (await signIn(app, otherManager.user.id)).headers,
    );

    expect(res.statusCode).toBe(404);
    const count = await app.db
      .selectFrom('memberships')
      .select('id')
      .where('condominium_id', '=', condo.id)
      .where('role', '=', 'front_desk')
      .execute();
    expect(count).toHaveLength(0);
  });
});
