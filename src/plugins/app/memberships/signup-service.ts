import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { CondominiumNotFound, Unauthenticated } from '../authorization.ts';
import type { PendingMembership } from './signup-repository.ts';

export type UnitChoice = { unitId: string; unitRelation: 'owner' | 'tenant' };

/**
 * Cadastro pelo link/QR Code do condomínio (spec 001, req. 6–9). O vínculo nasce
 * pendente e o síndico é avisado. O link sozinho não dá acesso a nada (casos de borda).
 */
export function createSignupService(fastify: FastifyInstance) {
  const {
    condominiumsRepository,
    blocksRepository,
    signupRepository,
    usersRepository,
    passwordManager,
    notifier,
    config,
  } = fastify;

  async function condominiumByCode(code: string) {
    const condominium = await condominiumsRepository.findByPublicCode(code);
    if (!condominium) throw new CondominiumNotFound();
    return condominium;
  }

  /** Avisa o síndico sem aguardar: o cadastro já valeu; falha no envio só vai para o log. */
  function notifyManager(
    condominium: { id: string; name: string },
    residentName: string,
    pending: Pick<PendingMembership, 'membershipId' | 'unitLabel'>,
  ) {
    void signupRepository
      .findManager(condominium.id)
      .then((manager) => {
        if (!manager) return;
        return notifier.send({
          type: 'membership_pending',
          to: { name: manager.name, email: manager.email },
          condominiumName: condominium.name,
          residentName,
          unitLabel: pending.unitLabel,
          reviewUrl: `${config.WEB_ORIGIN}/condominios/${condominium.id}/moradores`,
        });
      })
      .catch((err: unknown) => {
        fastify.log.error(
          { err, membershipId: pending.membershipId },
          'Falha ao avisar o síndico do cadastro pendente',
        );
      });
  }

  return {
    notifyManager,

    /** Nome do condomínio e as unidades que podem ser escolhidas (req. 8). */
    async publicInfo(code: string) {
      const condominium = await condominiumByCode(code);
      return {
        name: condominium.name,
        blocks: await blocksRepository.listWithUnits(condominium.id),
      };
    },

    async signup(
      code: string,
      input: { name: string; email: string; phone: string; password: string } & UnitChoice,
    ): Promise<PendingMembership> {
      const condominium = await condominiumByCode(code);
      const pending = await signupRepository.signup(
        {
          name: input.name,
          email: input.email,
          phone: input.phone.replace(/\D/g, ''),
          passwordHash: await passwordManager.hash(input.password),
        },
        { condominiumId: condominium.id, unitId: input.unitId, unitRelation: input.unitRelation },
      );
      notifyManager(condominium, input.name.trim(), pending);
      return pending;
    },

    /** Quem já tem conta pede acesso a mais um condomínio (mesmo e-mail, req. 23). */
    async join(code: string, userId: string, choice: UnitChoice): Promise<PendingMembership> {
      const condominium = await condominiumByCode(code);
      const user = await usersRepository.findById(userId);
      if (!user) throw new Unauthenticated();
      const pending = await signupRepository.join(user.id, {
        condominiumId: condominium.id,
        unitId: choice.unitId,
        unitRelation: choice.unitRelation,
      });
      notifyManager(condominium, user.name, pending);
      return pending;
    },
  };
}

export type SignupService = ReturnType<typeof createSignupService>;

export default fp(
  async function signupServicePlugin(fastify) {
    fastify.decorate('signupService', createSignupService(fastify));
  },
  {
    name: 'signup-service',
    dependencies: [
      'condominiums-repository',
      'blocks-repository',
      'signup-repository',
      'users-repository',
      'password-manager',
      'notifier',
    ],
  },
);

declare module 'fastify' {
  interface FastifyInstance {
    signupService: SignupService;
  }
}
