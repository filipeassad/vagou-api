import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { FrontDeskAccess } from './front-desk-repository.ts';

/** O síndico cria ou redefine o acesso da portaria (spec 001, req. 4; plano 001, D12). */
export function createFrontDeskService(fastify: FastifyInstance) {
  const { frontDeskRepository, passwordManager } = fastify;

  return {
    get(condominiumId: string): Promise<FrontDeskAccess | null> {
      return frontDeskRepository.find(condominiumId);
    },

    async set(
      condominiumId: string,
      input: { email: string; password: string; managerId: string },
    ): Promise<FrontDeskAccess> {
      return frontDeskRepository.set(condominiumId, {
        email: input.email,
        passwordHash: await passwordManager.hash(input.password),
        decidedBy: input.managerId,
      });
    },
  };
}

export type FrontDeskService = ReturnType<typeof createFrontDeskService>;

export default fp(
  async function frontDeskServicePlugin(fastify) {
    fastify.decorate('frontDeskService', createFrontDeskService(fastify));
  },
  { name: 'front-desk-service', dependencies: ['front-desk-repository', 'password-manager'] },
);

declare module 'fastify' {
  interface FastifyInstance {
    frontDeskService: FrontDeskService;
  }
}
