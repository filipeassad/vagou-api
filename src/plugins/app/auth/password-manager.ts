import { hash, verify } from '@node-rs/argon2';
import fp from 'fastify-plugin';

/**
 * Hash de senha com Argon2id (plano 001, D4). Parâmetros mínimos recomendados pela
 * OWASP: 19 MiB de memória, 2 iterações, 1 thread. O algoritmo e os parâmetros ficam
 * gravados no próprio hash ($argon2id$v=19$m=19456,t=2,p=1$...), então mudar os
 * valores aqui não invalida senhas antigas.
 */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function createPasswordManager() {
  return {
    hash(password: string): Promise<string> {
      return hash(password, ARGON2_OPTIONS);
    },

    /** Nunca lança erro: hash inválido ou corrompido conta como senha errada. */
    async verify(passwordHash: string, password: string): Promise<boolean> {
      try {
        return await verify(passwordHash, password);
      } catch {
        return false;
      }
    },
  };
}

export type PasswordManager = ReturnType<typeof createPasswordManager>;

export default fp(
  async function passwordManagerPlugin(fastify) {
    fastify.decorate('passwordManager', createPasswordManager());
  },
  { name: 'password-manager' },
);

declare module 'fastify' {
  interface FastifyInstance {
    passwordManager: PasswordManager;
  }
}
