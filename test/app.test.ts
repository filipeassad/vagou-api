import createError from '@fastify/error';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Type } from 'typebox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import serviceApp from '../src/app.ts';
import { testConfig } from './helper.ts';

const InviteExpired = createError(
  'INVITE_EXPIRED',
  'Este convite venceu. Peça um novo ao síndico.',
  410,
);

describe('formato padrão de erro', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(fp(serviceApp), { config: testConfig() });
    // Rotas só deste teste, para exercitar cada tipo de erro.
    app.post(
      '/test/validation',
      {
        schema: {
          body: Type.Object({ email: Type.String({ format: 'email' }), name: Type.String() }),
        },
      },
      async () => ({ ok: true }),
    );
    app.get('/test/vagou-error', async () => {
      throw new InviteExpired();
    });
    app.get('/test/crash', async () => {
      throw new Error('detalhe interno que não pode vazar');
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rota inexistente → 404 NOT_FOUND', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/nao-existe' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
  });

  it('validação → 400 VALIDATION_ERROR com os campos', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/validation',
      payload: { email: 'x' },
    });

    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('Dados inválidos.');
    expect(error.details.map((d: { field: string }) => d.field)).toEqual(
      expect.arrayContaining(['/name']),
    );
  });

  it('JSON malformado → 400 com mensagem genérica em português', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/validation',
      headers: { 'content-type': 'application/json' },
      payload: '{ruim',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Requisição inválida.' } });
  });

  it('erro do Vagou → status, código e mensagem do próprio erro', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/vagou-error' });

    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({
      error: { code: 'INVITE_EXPIRED', message: 'Este convite venceu. Peça um novo ao síndico.' },
    });
  });

  it('erro inesperado → 500 sem vazar detalhes', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/crash' });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente em instantes.' },
    });
    expect(res.body).not.toContain('detalhe interno');
  });
});
