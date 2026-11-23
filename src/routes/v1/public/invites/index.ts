import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import {
  AcceptInviteBody,
  AcceptedInvite,
  InviteTokenBody,
  PublicInvite,
} from '../../../../schemas/invites.ts';

const ErrorRef = Type.Ref('ErrorResponse');
const invalid = { 400: ErrorRef, 404: ErrorRef, 410: ErrorRef, 429: ErrorRef };

// /v1/public/invites: abrir e aceitar convite, sem login (req. 10, 12, 13).
// O token vai no corpo, não na URL: URLs entram nos logs de acesso (princípio VI).
const publicInviteRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post(
    '/lookup',
    {
      schema: {
        tags: ['public'],
        summary: 'Dados do convite (condomínio e unidade) ou o motivo de não valer',
        description:
          'Inexistente → 404 INVITE_NOT_FOUND. Usado, vencido ou cancelado → 410 INVITE_USED / INVITE_EXPIRED / INVITE_REVOKED, com a orientação de pedir outro ao síndico.',
        body: InviteTokenBody,
        response: { 200: PublicInvite, ...invalid },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request) => fastify.invitesService.lookup(request.body.token),
  );

  fastify.post(
    '/accept',
    {
      schema: {
        tags: ['public'],
        summary: 'Aceitar convite criando a conta: vínculo já aprovado',
        description:
          'Não faz login: o app chama POST /v1/auth/login em seguida. E-mail já cadastrado → 409 EMAIL_ALREADY_REGISTERED (quem tem conta entra e usa POST /v1/me/invites/accept). Duas pessoas ao mesmo tempo: só uma vence, a outra recebe 410 INVITE_USED.',
        body: AcceptInviteBody,
        response: { 201: AcceptedInvite, 409: ErrorRef, ...invalid },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { token, name, email, phone, password } = request.body;
      const accepted = await fastify.invitesService.acceptWithNewUser(token, {
        name,
        email,
        phone,
        password,
      });
      return reply.code(201).send({
        membership_id: accepted.membershipId,
        status: 'approved',
        condominium: accepted.condominium,
      });
    },
  );
};

export default publicInviteRoutes;
