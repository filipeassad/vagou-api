import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashOpaqueToken } from '../../../../src/plugins/app/auth/opaque-token.ts';
import type { Notification } from '../../../../src/plugins/app/notifications/messages.ts';
import { signIn } from '../../../fixtures.ts';
import { buildTestApp, sentNotifications } from '../../../helper.ts';
import { resetDatabase } from '../../../test-database.ts';

const OLD_PASSWORD = 'senha-antiga-123';
const NEW_PASSWORD = 'senha-nova-456';

/** Spec 001, req. 21; plano 001, D10. */
describe('esqueci / redefinir senha', () => {
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

  /** Cada requisição usa um IP próprio, para o rate limit não interferir. */
  function newIp() {
    ipCounter += 1;
    return `10.1.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
  }

  function post(url: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url, payload, remoteAddress: newIp() });
  }

  const forgot = (email: string) => post('/v1/auth/forgot-password', { email });
  const reset = (token: string, password = NEW_PASSWORD) =>
    post('/v1/auth/reset-password', { token, password });
  const login = (password: string) =>
    post('/v1/auth/login', { email: 'maria@example.com', password });

  async function createUser() {
    return app.usersRepository.create({
      name: 'Maria',
      email: 'maria@example.com',
      phone: '67999990000',
      passwordHash: await app.passwordManager.hash(OLD_PASSWORD),
    });
  }

  /** Token do último e-mail de redefinição (vem no fragmento do link). */
  function lastToken(): string {
    const sent = sentNotifications(app).filter(
      (n): n is Extract<Notification, { type: 'password_reset' }> => n.type === 'password_reset',
    );
    const url = new URL(sent.at(-1)!.resetUrl);
    return new URLSearchParams(url.hash.slice(1)).get('token')!;
  }

  async function requestToken() {
    expect((await forgot('maria@example.com')).statusCode).toBe(202);
    return lastToken();
  }

  it('responde igual para e-mail cadastrado e não cadastrado; só o cadastrado recebe', async () => {
    await createUser();

    const existing = await forgot('maria@example.com');
    const missing = await forgot('ninguem@example.com');

    expect(existing.statusCode).toBe(202);
    expect(missing.statusCode).toBe(202);
    expect(existing.body).toBe(missing.body);
    expect(sentNotifications(app)).toHaveLength(1);
    expect(sentNotifications(app)[0]).toMatchObject({
      type: 'password_reset',
      to: { name: 'Maria', email: 'maria@example.com' },
      expiresInMinutes: 30,
    });
  });

  it('o token vai no fragmento do link e o banco guarda só o hash', async () => {
    await createUser();
    const token = await requestToken();

    const notification = sentNotifications(app)[0] as { resetUrl: string };
    expect(notification.resetUrl).toMatch(/^http:\/\/localhost:5173\/redefinir-senha#token=/);
    const rows = await app.db.selectFrom('password_resets').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toEqual(hashOpaqueToken(token));
    expect(rows[0]!.token_hash.toString()).not.toContain(token);
  });

  it('o link vence em 30 minutos', async () => {
    await createUser();
    await requestToken();

    const { created_at, expires_at } = await app.db
      .selectFrom('password_resets')
      .select(['created_at', 'expires_at'])
      .executeTakeFirstOrThrow();
    expect((expires_at.getTime() - created_at.getTime()) / 60_000).toBeCloseTo(30, 3);
  });

  it('redefine a senha: a nova entra, a antiga não, e todas as sessões caem', async () => {
    const user = await createUser();
    const phone = await signIn(app, user.id);
    const laptop = await signIn(app, user.id);
    const token = await requestToken();

    const res = await reset(token);

    expect(res.statusCode).toBe(204);
    expect((await login(NEW_PASSWORD)).statusCode).toBe(200);
    expect((await login(OLD_PASSWORD)).statusCode).toBe(401);
    for (const session of [phone, laptop]) {
      expect(await app.sessionsRepository.findActiveWithUser(session.sessionId, user.id)).toBe(
        undefined,
      );
    }
  });

  it('o token é de uso único', async () => {
    await createUser();
    const token = await requestToken();
    expect((await reset(token)).statusCode).toBe(204);

    const again = await reset(token, 'outra-senha-789');

    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('INVALID_RESET_TOKEN');
    expect((await login(NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('duas redefinições simultâneas com o mesmo token: só uma vence', async () => {
    await createUser();
    const token = await requestToken();

    const results = await Promise.all([
      reset(token, 'senha-um-111'),
      reset(token, 'senha-dois-222'),
    ]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([204, 400]);
  });

  it('token vencido é recusado', async () => {
    await createUser();
    const token = await requestToken();
    await app.db
      .updateTable('password_resets')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();

    const res = await reset(token);

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_RESET_TOKEN');
    expect((await login(OLD_PASSWORD)).statusCode).toBe(200);
  });

  it('token desconhecido é recusado', async () => {
    const res = await reset('token-que-nao-existe');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('pedir de novo invalida o link anterior', async () => {
    await createUser();
    const first = await requestToken();
    // Passa o intervalo de 1 minuto entre e-mails.
    await app.db
      .updateTable('password_resets')
      .set({ created_at: new Date(Date.now() - 2 * 60_000) })
      .execute();
    const second = await requestToken();

    expect(second).not.toBe(first);
    expect((await reset(first)).statusCode).toBe(400);
    expect((await reset(second)).statusCode).toBe(204);
  });

  it('no máximo um e-mail por minuto por conta (resposta continua igual)', async () => {
    await createUser();

    const first = await forgot('maria@example.com');
    const second = await forgot('maria@example.com');

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(sentNotifications(app)).toHaveLength(1);
  });

  it('senha nova curta é recusada e não gasta o token', async () => {
    await createUser();
    const token = await requestToken();

    const short = await reset(token, '1234567');

    expect(short.statusCode).toBe(400);
    expect(short.json().error.code).toBe('VALIDATION_ERROR');
    expect((await reset(token)).statusCode).toBe(204);
  });

  it('redefinir desfaz o bloqueio de login', async () => {
    const user = await createUser();
    await app.db
      .updateTable('users')
      .set({ locked_until: new Date(Date.now() + 15 * 60_000), failed_login_attempts: 3 })
      .where('id', '=', user.id)
      .execute();
    const token = await requestToken();

    expect((await reset(token)).statusCode).toBe(204);
    expect((await login(NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('falha do fornecedor de e-mail não muda a resposta', async () => {
    await createUser();
    vi.spyOn(app.notifier, 'send').mockRejectedValue(new Error('fornecedor fora do ar'));

    const res = await forgot('maria@example.com');

    expect(res.statusCode).toBe(202);
  });
});
