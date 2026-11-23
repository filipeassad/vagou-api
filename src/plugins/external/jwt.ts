import { createHash } from 'node:crypto';
import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';

/** Validade do access token (plano 001, D5). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Access token JWT (plano 001, D5): HS256, 15 min, claims só `sub` (usuário) e `sid`
 * (sessão). O `kid` no cabeçalho identifica a chave: é derivado do próprio segredo, então
 * muda sozinho quando o JWT_SECRET for trocado e permite aceitar duas chaves na transição.
 */
export default fp(
  async function jwt(fastify) {
    const secret = fastify.config.JWT_SECRET;
    const kid = createHash('sha256').update(secret).digest('hex').slice(0, 8);

    await fastify.register(fastifyJwt, {
      secret,
      sign: { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_TTL_SECONDS, kid },
      verify: { algorithms: ['HS256'] },
    });
  },
  { name: 'jwt' },
);

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; sid: string };
    user: { sub: string; sid: string; iat: number; exp: number };
  }
}
