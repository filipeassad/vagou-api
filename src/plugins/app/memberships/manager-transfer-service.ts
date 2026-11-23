import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { ManagerTransfer } from './memberships-repository.ts';

/** Troca de síndico, pelo síndico atual ou pelo admin (spec 001, req. 5). */
export function createManagerTransferService(fastify: FastifyInstance) {
  const { membershipsRepository, notifier, config } = fastify;

  return {
    async transfer(
      condominiumId: string,
      target: { membershipId: string } | { email: string },
      /** Síndico que pede a troca; null quando é o admin. */
      actorUserId: string | null,
    ): Promise<ManagerTransfer> {
      const result = await membershipsRepository.transferManager(
        condominiumId,
        target,
        actorUserId,
      );

      // Não aguarda: a troca já valeu; falha no envio só vai para o log.
      notifier
        .send({
          type: 'manager_role_received',
          to: { name: result.manager.name, email: result.manager.email },
          condominiumName: result.condominium.name,
          appUrl: `${config.WEB_ORIGIN}/entrar`,
        })
        .catch((err: unknown) => {
          fastify.log.error(
            { err, userId: result.manager.user_id },
            'Falha ao avisar o novo síndico',
          );
        });

      return result;
    },
  };
}

export type ManagerTransferService = ReturnType<typeof createManagerTransferService>;

export default fp(
  async function managerTransferServicePlugin(fastify) {
    fastify.decorate('managerTransferService', createManagerTransferService(fastify));
  },
  { name: 'manager-transfer-service', dependencies: ['memberships-repository', 'notifier'] },
);

declare module 'fastify' {
  interface FastifyInstance {
    managerTransferService: ManagerTransferService;
  }
}
