import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { AcceptedInvite, InviteTokenBody } from '../../../../schemas/invites.ts';

const ErrorRef = Type.Ref('ErrorResponse');

// /v1/me/invites: quem já tem conta aceita o convite logado (mesmo e-mail em dois condomínios)
const myInviteRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post(
    '/accept',
    {
      schema: {
        tags: ['invites'],
        summary: 'Aceitar convite com a conta atual',
        description:
          'Vínculo já aprovado. Já tem cadastro neste condomínio → 409 ALREADY_MEMBER (o convite continua valendo).',
        security: [{ bearerAuth: [] }],
        body: InviteTokenBody,
        response: {
          201: AcceptedInvite,
          400: ErrorRef,
          401: ErrorRef,
          404: ErrorRef,
          409: ErrorRef,
          410: ErrorRef,
        },
      },
      onRequest: fastify.authenticate,
    },
    async (request, reply) => {
      const accepted = await fastify.invitesService.acceptWithExistingUser(
        request.body.token,
        request.auth!.userId,
      );
      return reply.code(201).send({
        membership_id: accepted.membershipId,
        status: 'approved',
        condominium: accepted.condominium,
      });
    },
  );
};

export default myInviteRoutes;
