import fastifyCookie from '@fastify/cookie';
import fp from 'fastify-plugin';

/** Cookies: usados só para o refresh token do web, em /v1/auth (plano 001, D6). */
export default fp(
  async function cookie(fastify) {
    await fastify.register(fastifyCookie);
  },
  { name: 'cookie' },
);
