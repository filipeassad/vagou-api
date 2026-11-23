import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { ACCESS } from '../../../../../plugins/app/authorization.ts';
import { CondominiumParams } from '../../../../../schemas/condominiums.ts';
import {
  ApproveBody,
  CanListSpotsBody,
  MembershipListQuery,
  MembershipParams,
  RejectBody,
  ResidentList,
  ResubmitBody,
} from '../../../../../schemas/memberships.ts';

const ErrorRef = Type.Ref('ErrorResponse');
const errors = { 401: ErrorRef, 403: ErrorRef, 404: ErrorRef };
const done = { 204: Type.Null({ description: 'Feito' }) };

// /v1/condominiums/:cid/memberships: aprovação, permissões e remoção (req. 15–19, 24)
const membershipRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const managerOnly = { access: ACCESS.manager };
  const security = [{ bearerAuth: [] }];

  fastify.get(
    '/',
    {
      schema: {
        tags: ['memberships'],
        summary: 'Moradores do condomínio (síndico)',
        description:
          'Pendentes, aprovados e recusados; filtra por ?status=. A portaria não aparece.',
        security,
        params: CondominiumParams,
        querystring: MembershipListQuery,
        response: { 200: ResidentList, ...errors },
      },
      config: managerOnly,
    },
    async (request) => ({
      items: await fastify.reviewsService.list(request.params.cid, request.query.status),
    }),
  );

  // Rota estática: tem precedência sobre /:id. Só o próprio morador, pendente ou recusado.
  fastify.patch(
    '/me',
    {
      schema: {
        tags: ['memberships'],
        summary: 'Corrigir e reenviar o próprio cadastro (morador)',
        description:
          'Recusado ou pendente volta a pendente, sem o motivo da recusa; o síndico é avisado de novo.',
        security,
        params: CondominiumParams,
        body: ResubmitBody,
        response: { ...done, 400: ErrorRef, 409: ErrorRef, ...errors },
      },
      config: { access: { roles: ['resident'], statuses: ['pending', 'rejected'] } },
    },
    async (request, reply) => {
      await fastify.reviewsService.resubmit(
        request.params.cid,
        request.membership!.id,
        request.auth!.userId,
        { unitId: request.body.unit_id, unitRelation: request.body.unit_relation },
      );
      return reply.code(204).send(null);
    },
  );

  fastify.post(
    '/:id/approve',
    {
      schema: {
        tags: ['memberships'],
        summary: 'Aprovar cadastro pendente',
        description:
          'O morador é avisado. Só cadastro pendente (senão 409 INVALID_MEMBERSHIP_STATUS).',
        security,
        params: MembershipParams,
        body: ApproveBody,
        response: { ...done, 400: ErrorRef, 409: ErrorRef, ...errors },
      },
      config: managerOnly,
    },
    async (request, reply) => {
      await fastify.reviewsService.approve(request.params.cid, request.params.id, {
        canListSpots: request.body.can_list_spots,
        decidedBy: request.auth!.userId,
      });
      return reply.code(204).send(null);
    },
  );

  fastify.post(
    '/:id/reject',
    {
      schema: {
        tags: ['memberships'],
        summary: 'Recusar cadastro pendente',
        description: 'O morador é avisado com o motivo e pode corrigir e reenviar.',
        security,
        params: MembershipParams,
        body: RejectBody,
        response: { ...done, 400: ErrorRef, 409: ErrorRef, ...errors },
      },
      config: managerOnly,
    },
    async (request, reply) => {
      await fastify.reviewsService.reject(request.params.cid, request.params.id, {
        reason: request.body.reason?.trim() ?? null,
        decidedBy: request.auth!.userId,
      });
      return reply.code(204).send(null);
    },
  );

  fastify.post(
    '/:id/remove',
    {
      schema: {
        tags: ['memberships'],
        summary: 'Remover morador (ex.: mudou-se)',
        description:
          'Qualquer situação (pendente, aprovado, recusado). O acesso ao condomínio acaba no próximo request; sem outro vínculo ativo, as sessões do usuário são encerradas. O síndico não remove a si mesmo: 409 CANNOT_REMOVE_MANAGER (transfira o papel antes). A portaria e vínculos já removidos → 404.',
        security,
        params: MembershipParams,
        response: { ...done, 409: ErrorRef, ...errors },
      },
      config: managerOnly,
    },
    async (request, reply) => {
      await fastify.reviewsService.remove(
        request.params.cid,
        request.params.id,
        request.auth!.userId,
      );
      return reply.code(204).send(null);
    },
  );

  fastify.patch(
    '/:id',
    {
      schema: {
        tags: ['memberships'],
        summary: 'Alterar a permissão de anunciar de um morador aprovado',
        security,
        params: MembershipParams,
        body: CanListSpotsBody,
        response: { ...done, 400: ErrorRef, 409: ErrorRef, ...errors },
      },
      config: managerOnly,
    },
    async (request, reply) => {
      await fastify.reviewsService.setCanListSpots(
        request.params.cid,
        request.params.id,
        request.body.can_list_spots,
      );
      return reply.code(204).send(null);
    },
  );
};

export default membershipRoutes;
