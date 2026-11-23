import createError from '@fastify/error';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { generateOpaqueToken, hashOpaqueToken } from '../auth/opaque-token.ts';
import type { InviteListItem, Relation } from './invites-repository.ts';

/** WhatsApp (req. 11) depende da aprovação da conta Meta (plano 001, seção 8). */
export const ChannelUnavailable = createError(
  'CHANNEL_UNAVAILABLE',
  'O envio por WhatsApp ainda não está disponível. Envie por e-mail ou compartilhe o link.',
  422,
);

export const RecipientEmailRequired = createError(
  'RECIPIENT_EMAIL_REQUIRED',
  'Informe o e-mail de quem vai receber o convite.',
  400,
);

/** O fornecedor de e-mail falhou. O link novo já vale; reenviar gera outro. */
export const InviteSendFailed = createError(
  'INVITE_SEND_FAILED',
  'Não foi possível enviar o e-mail agora. Tente de novo ou compartilhe o link você mesmo.',
  502,
);

/** Convites individuais do síndico (spec 001, req. 10–14, 17). */
export function createInvitesService(fastify: FastifyInstance) {
  const { invitesRepository, passwordManager, notifier, config } = fastify;

  /**
   * Link entregue ao síndico. O token vai no fragmento (`#token=`), que o navegador não
   * envia a servidores: não aparece em logs de acesso (princípio VI; mesmo padrão da T10).
   * A tela do web lê o fragmento e manda o token no corpo das rotas públicas.
   */
  function inviteUrl(token: string) {
    return `${config.WEB_ORIGIN}/convite#token=${token}`;
  }

  return {
    /** Gera o convite. O link (com o token) só aparece nesta resposta: o banco guarda o hash. */
    async create(input: {
      condominiumId: string;
      unitId: string;
      unitRelation: Relation;
      canListSpots: boolean;
      createdBy: string;
    }): Promise<InviteListItem & { invite_url: string }> {
      const token = generateOpaqueToken();
      const invite = await invitesRepository.create({
        ...input,
        tokenHash: hashOpaqueToken(token),
      });
      return { ...invite, invite_url: inviteUrl(token) };
    },

    /**
     * Envio pela plataforma (req. 11). Gera um link novo (o anterior deixa de valer: só o
     * hash fica guardado) e aguarda o envio, para o síndico saber se deu certo.
     */
    async send(
      condominiumId: string,
      inviteId: string,
      input: {
        channel: 'email' | 'whatsapp';
        recipient: { name: string; email?: string; phone?: string };
      },
    ): Promise<InviteListItem & { invite_url: string }> {
      if (input.channel === 'whatsapp') throw new ChannelUnavailable();
      const email = input.recipient.email;
      if (!email) throw new RecipientEmailRequired();

      const token = generateOpaqueToken();
      const { condominium_name, ...invite } = await invitesRepository.rotateForSending(
        condominiumId,
        inviteId,
        { tokenHash: hashOpaqueToken(token), recipientEmail: email },
      );
      const url = inviteUrl(token);

      try {
        await notifier.send({
          type: 'invite',
          to: { name: input.recipient.name.trim(), email },
          condominiumName: condominium_name,
          inviteUrl: url,
          expiresAt: invite.expires_at,
        });
      } catch (err) {
        fastify.log.error({ err, inviteId }, 'Falha ao enviar o convite por e-mail');
        throw new InviteSendFailed();
      }
      return { ...invite, invite_url: url };
    },

    list: invitesRepository.list,
    revoke: invitesRepository.revoke,

    lookup(token: string) {
      return invitesRepository.findForPublic(hashOpaqueToken(token));
    },

    async acceptWithNewUser(
      token: string,
      user: { name: string; email: string; phone: string; password: string },
    ) {
      return invitesRepository.acceptWithNewUser(hashOpaqueToken(token), {
        name: user.name,
        email: user.email,
        phone: user.phone.replace(/\D/g, ''),
        passwordHash: await passwordManager.hash(user.password),
      });
    },

    acceptWithExistingUser(token: string, userId: string) {
      return invitesRepository.acceptWithExistingUser(hashOpaqueToken(token), userId);
    },
  };
}

export type InvitesService = ReturnType<typeof createInvitesService>;

export default fp(
  async function invitesServicePlugin(fastify) {
    fastify.decorate('invitesService', createInvitesService(fastify));
  },
  { name: 'invites-service', dependencies: ['invites-repository', 'password-manager', 'notifier'] },
);

declare module 'fastify' {
  interface FastifyInstance {
    invitesService: InvitesService;
  }
}
