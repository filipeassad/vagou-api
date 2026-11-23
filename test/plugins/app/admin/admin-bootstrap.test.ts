import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../../../src/plugins/app/admin/admin-bootstrap.ts';
import { hashOpaqueToken } from '../../../../src/plugins/app/auth/opaque-token.ts';
import { buildTestApp } from '../../../helper.ts';
import { resetDatabase } from '../../../test-database.ts';

/** `npm run admin:criar` (plano 001, D11). */
describe('bootstrapAdmin', () => {
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

  it('cria o admin sem senha e devolve o token de definir senha (24 h)', async () => {
    const result = await bootstrapAdmin(app.db, { name: 'Dona', email: 'dona@example.com' });

    expect(result.created).toBe(true);
    const user = await app.usersRepository.findById(result.userId);
    expect(user?.is_admin).toBe(true);
    const reset = await app.db.selectFrom('password_resets').selectAll().executeTakeFirstOrThrow();
    expect(reset.token_hash).toEqual(hashOpaqueToken(result.setupToken!));
    expect((reset.expires_at.getTime() - reset.created_at.getTime()) / 3_600_000).toBeCloseTo(
      24,
      5,
    );
  });

  it('promove conta existente com senha, sem token', async () => {
    const existing = await app.usersRepository.create({
      name: 'Dona',
      email: 'dona@example.com',
      phone: null,
      passwordHash: await app.passwordManager.hash('senha-da-dona-1'),
    });

    const result = await bootstrapAdmin(app.db, { name: 'Outro nome', email: 'DONA@example.com' });

    expect(result).toEqual({ userId: existing.id, created: false, setupToken: null });
    expect((await app.usersRepository.findById(existing.id))?.is_admin).toBe(true);
  });
});
