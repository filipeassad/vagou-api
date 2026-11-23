import createError from '@fastify/error';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { generateOpaqueToken, hashOpaqueToken } from './opaque-token.ts';

/** Esqueci minha senha (spec 001, req. 21; plano 001, D10). */
export const PASSWORD_RESET_TTL_MINUTES = 30;
/** Um e-mail por minuto por conta: impede usar a rota para lotar a caixa de alguém. */
export const PASSWORD_RESET_COOLDOWN_SECONDS = 60;

export const InvalidResetToken = createError(
  'INVALID_RESET_TOKEN',
  'Este link de redefinição é inválido ou já venceu. Peça um novo em "Esqueci minha senha".',
  400,
);

export function createPasswordResetService(fastify: FastifyInstance) {
  const { usersRepository, passwordResetsRepository, passwordManager, notifier, config } = fastify;

  /**
   * Link do e-mail. O token vai no fragmento (`#token=`), que o navegador não envia a
   * nenhum servidor nem repassa no Referer: não aparece em logs de acesso (princípio VI).
   * A tela do web lê o fragmento e manda o token no corpo do `reset-password`.
   */
  function resetUrl(token: string) {
    return `${config.WEB_ORIGIN}/redefinir-senha#token=${token}`;
  }

  return {
    /**
     * Envia o link se o e-mail tiver conta. Quem chama responde sempre igual, exista o
     * e-mail ou não. O envio não é aguardado: o tempo de resposta não denuncia quem
     * tem conta, e uma falha do fornecedor só vai para o log.
     */
    async requestReset(email: string): Promise<void> {
      const user = await usersRepository.findCredentialsByEmail(email);
      if (!user) return;

      const last = await passwordResetsRepository.lastRequestedAt(user.id);
      if (last && Date.now() - last.getTime() < PASSWORD_RESET_COOLDOWN_SECONDS * 1000) return;

      const token = generateOpaqueToken();
      await passwordResetsRepository.create({
        userId: user.id,
        tokenHash: hashOpaqueToken(token),
        ttlMinutes: PASSWORD_RESET_TTL_MINUTES,
      });

      notifier
        .send({
          type: 'password_reset',
          to: { name: user.name, email: user.email },
          resetUrl: resetUrl(token),
          expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
        })
        .catch((err: unknown) => {
          fastify.log.error({ err, userId: user.id }, 'Falha ao enviar e-mail de redefinição');
        });
    },

    /** Troca a senha e encerra todas as sessões (quem roubou a senha antiga sai). */
    async resetPassword(token: string, newPassword: string): Promise<void> {
      const passwordHash = await passwordManager.hash(newPassword);
      const userId = await passwordResetsRepository.resetPassword(
        hashOpaqueToken(token),
        passwordHash,
      );
      if (!userId) throw new InvalidResetToken();
      fastify.log.info({ userId }, 'Senha redefinida; sessões encerradas');
    },
  };
}

export type PasswordResetService = ReturnType<typeof createPasswordResetService>;

export default fp(
  async function passwordResetServicePlugin(fastify) {
    fastify.decorate('passwordResetService', createPasswordResetService(fastify));
  },
  {
    name: 'password-reset-service',
    dependencies: [
      'users-repository',
      'password-resets-repository',
      'password-manager',
      'notifier',
    ],
  },
);

declare module 'fastify' {
  interface FastifyInstance {
    passwordResetService: PasswordResetService;
  }
}
