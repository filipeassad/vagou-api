import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Notification } from '../notifications/messages.ts';
import type { Relation } from './reviews-repository.ts';

/**
 * Síndico aprova/recusa cadastros e define quem anuncia; morador corrige e reenvia
 * (spec 001, req. 15–19). Avisos não são aguardados: a decisão já valeu e uma falha no
 * envio só vai para o log.
 */
export function createReviewsService(fastify: FastifyInstance) {
  const {
    reviewsRepository,
    condominiumsRepository,
    usersRepository,
    signupService,
    notifier,
    config,
  } = fastify;

  function notify(notification: Notification, membershipId: string) {
    notifier.send(notification).catch((err: unknown) => {
      fastify.log.error(
        { err, membershipId, type: notification.type },
        'Falha ao avisar o morador',
      );
    });
  }

  return {
    list: reviewsRepository.list,
    setCanListSpots: reviewsRepository.setCanListSpots,
    /** Remoção (req. 24, 25). Sem aviso ao morador: a spec não pede (ver plano, seção 10). */
    remove: reviewsRepository.remove,

    async approve(
      condominiumId: string,
      membershipId: string,
      input: { canListSpots: boolean; decidedBy: string },
    ) {
      const decided = await reviewsRepository.approve(condominiumId, membershipId, input);
      notify(
        {
          type: 'membership_approved',
          to: { name: decided.user.name, email: decided.user.email },
          condominiumName: decided.condominium.name,
          appUrl: `${config.WEB_ORIGIN}/entrar`,
        },
        membershipId,
      );
    },

    async reject(
      condominiumId: string,
      membershipId: string,
      input: { reason: string | null; decidedBy: string },
    ) {
      const decided = await reviewsRepository.reject(condominiumId, membershipId, input);
      notify(
        {
          type: 'membership_rejected',
          to: { name: decided.user.name, email: decided.user.email },
          condominiumName: decided.condominium.name,
          reason: input.reason,
        },
        membershipId,
      );
    },

    /** O morador reenvia o próprio cadastro: volta a pendente e o síndico é avisado de novo. */
    async resubmit(
      condominiumId: string,
      membershipId: string,
      userId: string,
      patch: { unitId?: string; unitRelation?: Relation },
    ) {
      const { unitLabel } = await reviewsRepository.resubmit(condominiumId, membershipId, patch);
      const [condominium, user] = await Promise.all([
        condominiumsRepository.findById(condominiumId),
        usersRepository.findById(userId),
      ]);
      if (condominium && user) {
        signupService.notifyManager(condominium, user.name, { membershipId, unitLabel });
      }
    },
  };
}

export type ReviewsService = ReturnType<typeof createReviewsService>;

export default fp(
  async function reviewsServicePlugin(fastify) {
    fastify.decorate('reviewsService', createReviewsService(fastify));
  },
  {
    name: 'reviews-service',
    dependencies: [
      'reviews-repository',
      'condominiums-repository',
      'users-repository',
      'signup-service',
      'notifier',
    ],
  },
);

declare module 'fastify' {
  interface FastifyInstance {
    reviewsService: ReviewsService;
  }
}
