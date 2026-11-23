import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { JoinBody, PendingMembership } from '../../../../schemas/signup.ts';

const ErrorRef = Type.Ref('ErrorResponse');

// /v1/me/memberships: quem já tem conta pede acesso a outro condomínio pelo QR Code
const myMembershipRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post(
    '/',
    {
      schema: {
        tags: ['auth'],
        summary: 'Pedir acesso a um condomínio com a conta atual (QR Code)',
        description:
          'Para quem já tem conta (ex.: mora ou tem unidade em outro condomínio, mesmo e-mail). Vínculo pendente, o síndico é avisado. Já tem cadastro neste condomínio → 409 ALREADY_MEMBER.',
        security: [{ bearerAuth: [] }],
        body: JoinBody,
        response: {
          201: PendingMembership,
          400: ErrorRef,
          401: ErrorRef,
          404: ErrorRef,
          409: ErrorRef,
        },
      },
      onRequest: fastify.authenticate,
    },
    async (request, reply) => {
      const pending = await fastify.signupService.join(
        request.body.public_code,
        request.auth!.userId,
        { unitId: request.body.unit_id, unitRelation: request.body.unit_relation },
      );
      return reply.code(201).send({ membership_id: pending.membershipId, status: 'pending' });
    },
  );
};

export default myMembershipRoutes;
