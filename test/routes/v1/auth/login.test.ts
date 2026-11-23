import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashOpaqueToken } from '../../../../src/plugins/app/auth/opaque-token.ts';
import { REFRESH_COOKIE } from '../../../../src/routes/v1/auth/index.ts';
import { buildTestApp } from '../../../helper.ts';
import { resetDatabase } from '../../../test-database.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const PASSWORD = 'senha-forte-123';

describe('POST /v1/auth/login', () => {
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
  });

  /** Cada teste usa um IP próprio, para o rate limit de um não afetar o outro. */
  function newIp() {
    ipCounter += 1;
    return `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
  }

  async function createUser(email = 'maria@example.com', password: string | null = PASSWORD) {
    return app.usersRepository.create({
      name: 'Maria',
      email,
      phone: '67999990000',
      passwordHash: password ? await app.passwordManager.hash(password) : null,
    });
  }

  function login(body: Record<string, unknown>, ip: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: body,
      remoteAddress: ip,
      headers: { 'user-agent': 'vitest' },
    });
  }

  it('web: devolve access token e o refresh no cookie HttpOnly', async () => {
    const user = await createUser();

    const res = await login({ email: 'maria@example.com', password: PASSWORD }, newIp());

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 900 });
    expect(body).not.toHaveProperty('refresh_token');

    const claims = app.jwt.verify<{ sub: string; sid: string; exp: number; iat: number }>(
      body.access_token,
    );
    expect(claims.sub).toBe(user.id);
    expect(claims.exp - claims.iat).toBe(900);
    const header = JSON.parse(Buffer.from(body.access_token.split('.')[0], 'base64url').toString());
    expect(header).toMatchObject({ alg: 'HS256', kid: expect.any(String) });

    const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/v1/auth' });

    // O banco guarda só o hash do refresh token, na sessão indicada pelo `sid`.
    const session = await app.db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', claims.sid)
      .executeTakeFirstOrThrow();
    expect(session.user_id).toBe(user.id);
    expect(session.user_agent).toBe('vitest');
    expect(session.refresh_token_hash.equals(hashOpaqueToken(cookie!.value))).toBe(true);
    const days = (session.expires_at.getTime() - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);
  });

  it('mobile: devolve o refresh token no corpo, sem cookie', async () => {
    await createUser();

    const res = await login(
      { email: 'maria@example.com', password: PASSWORD, client: 'mobile' },
      newIp(),
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().refresh_token).toEqual(expect.any(String));
    expect(res.cookies.find((c) => c.name === REFRESH_COOKIE)).toBeUndefined();
  });

  it('aceita o e-mail com maiúsculas diferentes', async () => {
    await createUser('Maria@Example.com');

    const res = await login({ email: 'MARIA@example.com', password: PASSWORD }, newIp());

    expect(res.statusCode).toBe(200);
  });

  it('senha errada e e-mail inexistente recebem a mesma resposta', async () => {
    await createUser();
    const ip = newIp();

    const wrongPassword = await login({ email: 'maria@example.com', password: 'errada' }, ip);
    const unknownEmail = await login({ email: 'ninguem@example.com', password: PASSWORD }, ip);

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual({
      error: { code: 'INVALID_CREDENTIALS', message: 'E-mail ou senha incorretos.' },
    });
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
  });

  it('usuário que ainda não definiu senha não entra', async () => {
    await createUser('sindico@example.com', null);

    const res = await login({ email: 'sindico@example.com', password: PASSWORD }, newIp());

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('5 senhas erradas bloqueiam por 15 min, até para a senha certa (req. 22)', async () => {
    const user = await createUser();
    const ip = newIp();

    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await login({ email: 'maria@example.com', password: 'errada' }, ip);
      expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    }
    const fifth = await login({ email: 'maria@example.com', password: 'errada' }, ip);
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().error).toEqual({
      code: 'LOGIN_BLOCKED',
      message: 'Muitas tentativas erradas. Aguarde 15 minutos ou use "Esqueci minha senha".',
    });

    const correctWhileLocked = await login({ email: 'maria@example.com', password: PASSWORD }, ip);
    expect(correctWhileLocked.statusCode).toBe(429);
    expect(correctWhileLocked.json().error.code).toBe('LOGIN_BLOCKED');

    const { locked_until } = await app.db
      .selectFrom('users')
      .select('locked_until')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    const minutes = (locked_until!.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14.9);
    expect(minutes).toBeLessThan(15.1); // o relógio do Postgres (Docker) pode estar uns ms à frente

    // Passados os 15 minutos, a senha certa entra e o contador zera.
    await app.db
      .updateTable('users')
      .set({ locked_until: new Date(Date.now() - 1000) })
      .where('id', '=', user.id)
      .execute();
    const afterLock = await login({ email: 'maria@example.com', password: PASSWORD }, ip);
    expect(afterLock.statusCode).toBe(200);
    const after = await app.db
      .selectFrom('users')
      .select(['failed_login_attempts', 'locked_until'])
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ failed_login_attempts: 0, locked_until: null });
  });

  it('login certo zera as tentativas erradas anteriores', async () => {
    const user = await createUser();
    const ip = newIp();

    await login({ email: 'maria@example.com', password: 'errada' }, ip);
    await login({ email: 'maria@example.com', password: 'errada' }, ip);
    await login({ email: 'maria@example.com', password: PASSWORD }, ip);

    const row = await app.db
      .selectFrom('users')
      .select('failed_login_attempts')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(row.failed_login_attempts).toBe(0);
  });

  it('portaria recebe sessão de 30 dias', async () => {
    const user = await createUser('portaria@example.com');
    const condominium = await app.db
      .insertInto('condominiums')
      .values({ name: 'Residencial', address: 'Rua A, 1', public_code: 'abc' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await app.db
      .insertInto('memberships')
      .values({
        user_id: user.id,
        condominium_id: condominium.id,
        role: 'front_desk',
        status: 'approved',
        origin: 'manager',
      })
      .execute();

    const res = await login(
      { email: 'portaria@example.com', password: PASSWORD, client: 'mobile' },
      newIp(),
    );

    const session = await app.db
      .selectFrom('sessions')
      .select('expires_at')
      .where('refresh_token_hash', '=', hashOpaqueToken(res.json().refresh_token))
      .executeTakeFirstOrThrow();
    const days = (session.expires_at.getTime() - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
  });

  it('valida o corpo da requisição', async () => {
    const res = await login({ email: 'nao-e-email' }, newIp());

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rate limit: a 11ª tentativa do mesmo IP no minuto recebe 429', async () => {
    const ip = newIp();
    for (let i = 0; i < 10; i++) {
      const res = await login({ email: `x${i}@example.com`, password: 'errada' }, ip);
      expect(res.statusCode).toBe(401);
    }

    const blocked = await login({ email: 'x@example.com', password: 'errada' }, ip);

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');

    // Outro IP continua podendo tentar.
    const otherIp = await login({ email: 'x@example.com', password: 'errada' }, newIp());
    expect(otherIp.statusCode).toBe(401);
  });
});
