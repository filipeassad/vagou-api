import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../../../helper.ts';
import { resetDatabase } from '../../../test-database.ts';

describe('usersRepository', () => {
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

  async function createMaria(email = 'Maria@Example.com') {
    return app.usersRepository.create({
      name: ' Maria Souza ',
      email,
      phone: '67999990000',
      passwordHash: await app.passwordManager.hash('senha-forte-123'),
    });
  }

  it('cria o usuário sem devolver o hash da senha', async () => {
    const user = await createMaria();

    expect(user).toMatchObject({
      name: 'Maria Souza',
      email: 'Maria@Example.com',
      phone: '67999990000',
      is_admin: false,
    });
    expect(user).not.toHaveProperty('password_hash');
  });

  it('recusa e-mail repetido com maiúsculas diferentes (req. 23)', async () => {
    await createMaria('Maria@Example.com');

    await expect(createMaria('  maria@EXAMPLE.com ')).rejects.toMatchObject({
      code: 'EMAIL_ALREADY_REGISTERED',
      statusCode: 409,
    });
  });

  it('encontra as credenciais pelo e-mail em qualquer caixa e a senha confere', async () => {
    const user = await createMaria();

    const credentials = await app.usersRepository.findCredentialsByEmail('MARIA@example.com');

    expect(credentials?.id).toBe(user.id);
    expect(credentials?.password_hash).not.toBe('senha-forte-123');
    expect(await app.passwordManager.verify(credentials!.password_hash!, 'senha-forte-123')).toBe(
      true,
    );
  });

  it('busca por id sem o hash da senha; id inexistente devolve undefined', async () => {
    const user = await createMaria();

    const found = await app.usersRepository.findById(user.id);

    expect(found).toEqual(user);
    expect(found).not.toHaveProperty('password_hash');
    expect(
      await app.usersRepository.findById('00000000-0000-0000-0000-000000000000'),
    ).toBeUndefined();
  });

  it('aceita usuário sem senha (síndico criado pelo admin define depois)', async () => {
    const user = await app.usersRepository.create({
      name: 'Síndico',
      email: 'sindico@example.com',
      phone: null,
      passwordHash: null,
    });

    const credentials = await app.usersRepository.findCredentialsByEmail('sindico@example.com');
    expect(credentials?.password_hash).toBeNull();
    expect(user.phone).toBeNull();
  });
});
