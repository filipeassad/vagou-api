import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashOpaqueToken } from '../../../../src/plugins/app/auth/opaque-token.ts';
import { REFRESH_COOKIE } from '../../../../src/routes/v1/auth/index.ts';
import { buildTestApp } from '../../../helper.ts';
import { resetDatabase } from '../../../test-database.ts';

const PASSWORD = 'senha-forte-123';
const EMAIL = 'maria@example.com';

describe('sessões: /v1/auth/refresh e /v1/auth/logout', () => {
  let app: FastifyInstance;
  let ip: string;
  let ipCounter = 0;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    await app.usersRepository.create({
      name: 'Maria',
      email: EMAIL,
      phone: '67999990000',
      passwordHash: await app.passwordManager.hash(PASSWORD),
    });
    // IP próprio por teste, para o rate limit de um teste não afetar o outro.
    ipCounter += 1;
    ip = `10.1.0.${ipCounter}`;
  });

  async function loginMobile() {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: EMAIL, password: PASSWORD, client: 'mobile' },
      remoteAddress: ip,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { access_token: string; refresh_token: string };
  }

  function refreshMobile(refreshToken: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refresh_token: refreshToken },
      remoteAddress: ip,
    });
  }

  function sessionByToken(refreshToken: string) {
    return app.db
      .selectFrom('sessions')
      .selectAll()
      .where('refresh_token_hash', '=', hashOpaqueToken(refreshToken))
      .executeTakeFirstOrThrow();
  }

  /** Simula que a rotação aconteceu há `seconds` segundos (fora da janela de tolerância). */
  async function ageRotation(refreshToken: string, seconds: number) {
    await app.db
      .updateTable('sessions')
      .set({ revoked_at: new Date(Date.now() - seconds * 1000) })
      .where('refresh_token_hash', '=', hashOpaqueToken(refreshToken))
      .execute();
  }

  it('mobile: refresh devolve um par novo e o refresh antigo para de valer', async () => {
    const first = await loginMobile();

    const res = await refreshMobile(first.refresh_token);

    expect(res.statusCode).toBe(200);
    const second = res.json();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);

    // O access token novo aponta para a sessão nova; a antiga ficou encerrada e ligada a ela.
    const claims = app.jwt.verify<{ sid: string }>(second.access_token);
    const newSession = await sessionByToken(second.refresh_token);
    const oldSession = await sessionByToken(first.refresh_token);
    expect(claims.sid).toBe(newSession.id);
    expect(oldSession.revoked_at).not.toBeNull();
    expect(oldSession.replaced_by).toBe(newSession.id);

    await ageRotation(first.refresh_token, 60);
    expect((await refreshMobile(first.refresh_token)).statusCode).toBe(401);
  });

  it('web: refresh lê o cookie e devolve o cookie novo, sem token no corpo', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
      remoteAddress: ip,
    });
    const oldCookie = login.cookies.find((c) => c.name === REFRESH_COOKIE)!.value;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: oldCookie },
      remoteAddress: ip,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('refresh_token');
    const newCookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
    expect(newCookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/v1/auth' });
    expect(newCookie!.value).not.toBe(oldCookie);
  });

  it('reusar um refresh já trocado derruba TODAS as sessões do usuário', async () => {
    const phone = await loginMobile();
    const laptop = await loginMobile();
    const rotated = (await refreshMobile(phone.refresh_token)).json();
    await ageRotation(phone.refresh_token, 60);

    // Alguém (um atacante) usa o refresh antigo do celular.
    const reuse = await refreshMobile(phone.refresh_token);
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error).toEqual({
      code: 'INVALID_REFRESH_TOKEN',
      message: 'Sua sessão expirou. Entre novamente.',
    });

    // Nem o token novo do celular nem o do notebook valem mais.
    expect((await refreshMobile(rotated.refresh_token)).statusCode).toBe(401);
    expect((await refreshMobile(laptop.refresh_token)).statusCode).toBe(401);
    const active = await app.db
      .selectFrom('sessions')
      .select('id')
      .where('revoked_at', 'is', null)
      .execute();
    expect(active).toHaveLength(0);
  });

  it('dentro da janela de 10 s, reusar o refresh não derruba as sessões (duas abas)', async () => {
    const first = await loginMobile();
    const rotated = (await refreshMobile(first.refresh_token)).json();

    const late = await refreshMobile(first.refresh_token);

    expect(late.statusCode).toBe(401);
    expect((await refreshMobile(rotated.refresh_token)).statusCode).toBe(200);
  });

  it('duas trocas simultâneas do mesmo refresh: só uma vence', async () => {
    const first = await loginMobile();

    const results = await Promise.all([
      refreshMobile(first.refresh_token),
      refreshMobile(first.refresh_token),
    ]);

    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 401]);
    const winner = results.find((r) => r.statusCode === 200)!.json();
    expect((await refreshMobile(winner.refresh_token)).statusCode).toBe(200);
  });

  it('refresh vencido é recusado', async () => {
    const first = await loginMobile();
    await app.db
      .updateTable('sessions')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();

    expect((await refreshMobile(first.refresh_token)).statusCode).toBe(401);
  });

  it('refresh sem token ou com token desconhecido → 401', async () => {
    const empty = await app.inject({ method: 'POST', url: '/v1/auth/refresh', remoteAddress: ip });
    expect(empty.statusCode).toBe(401);
    expect(empty.json().error.code).toBe('INVALID_REFRESH_TOKEN');

    expect((await refreshMobile('token-que-nao-existe')).statusCode).toBe(401);
  });

  it('logout encerra a sessão; repetir o logout continua respondendo 204', async () => {
    const first = await loginMobile();
    const other = await loginMobile();

    const logout = () =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        payload: { refresh_token: first.refresh_token },
        remoteAddress: ip,
      });

    expect((await logout()).statusCode).toBe(204);
    expect((await refreshMobile(first.refresh_token)).statusCode).toBe(401);
    expect((await logout()).statusCode).toBe(204);

    // Só a sessão deste aparelho caiu; a outra continua.
    expect((await refreshMobile(other.refresh_token)).statusCode).toBe(200);
  });

  it('logout no web apaga o cookie', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
      remoteAddress: ip,
    });
    const cookie = login.cookies.find((c) => c.name === REFRESH_COOKIE)!.value;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      cookies: { [REFRESH_COOKIE]: cookie },
      remoteAddress: ip,
    });

    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((c) => c.name === REFRESH_COOKIE);
    expect(cleared?.value).toBe('');
    expect(cleared?.path).toBe('/v1/auth');
    expect((await sessionByToken(cookie)).revoked_at).not.toBeNull();
  });
});
