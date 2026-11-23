import createError from '@fastify/error';
import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type {
  Membership,
  MembershipRole,
  MembershipStatus,
} from './memberships/memberships-repository.ts';

/**
 * Autenticação e autorização (plano 001, D8 e seção 5; princípio I).
 *
 * - `fastify.authenticate`: hook que exige `Authorization: Bearer <access token>` válido
 *   e sessão ainda ativa. Preenche `request.auth`.
 * - `fastify.authorizeCondominium`: hook das rotas `/v1/condominiums/:cid/*`. Busca o
 *   vínculo do usuário com `:cid` e aplica a regra da rota (`config.access`). Sem
 *   vínculo → 404, para não revelar que o condomínio existe. Preenche `request.membership`.
 *
 * Os dois são aplicados juntos em `routes/v1/condominiums/autohooks.ts`.
 */

export const Unauthenticated = createError(
  'UNAUTHENTICATED',
  'Sua sessão expirou ou você não entrou. Entre na sua conta para continuar.',
  401,
);

export const CondominiumNotFound = createError(
  'CONDOMINIUM_NOT_FOUND',
  'Condomínio não encontrado.',
  404,
);

export const MembershipPending = createError(
  'MEMBERSHIP_PENDING',
  'Seu cadastro ainda está aguardando a aprovação do síndico.',
  403,
);

export const MembershipRejected = createError(
  'MEMBERSHIP_REJECTED',
  'Seu cadastro foi recusado pelo síndico. Corrija os dados e envie de novo.',
  403,
);

export const Forbidden = createError('FORBIDDEN', 'Você não tem permissão para isso.', 403);

/** Quem pode usar uma rota de condomínio. Declarado em `config.access` de cada rota. */
export type AccessRule = {
  roles: readonly MembershipRole[];
  /** Situações do vínculo aceitas. Padrão: só `approved`. */
  statuses?: readonly MembershipStatus[];
};

/**
 * Regra usada quando a rota não declara `config.access`: morador ou síndico aprovado.
 * A portaria fica de fora por padrão (só acessa as rotas que a incluem explicitamente).
 */
export const DEFAULT_ACCESS: AccessRule = { roles: ['resident', 'manager'] };

/** Regras prontas para as rotas. */
export const ACCESS = {
  resident: DEFAULT_ACCESS,
  manager: { roles: ['manager'] },
  frontDesk: { roles: ['front_desk'] },
  anyApproved: { roles: ['resident', 'manager', 'front_desk'] },
} as const satisfies Record<string, AccessRule>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default fp(
  async function authorization(fastify) {
    fastify.decorateRequest('auth', null);
    fastify.decorateRequest('membership', null);

    fastify.decorate('authenticate', async function authenticate(request: FastifyRequest) {
      let claims: { sub: string; sid: string };
      try {
        claims = await request.jwtVerify();
      } catch {
        throw new Unauthenticated();
      }
      const session = await fastify.sessionsRepository.findActiveWithUser(claims.sid, claims.sub);
      if (!session) throw new Unauthenticated();
      request.auth = {
        userId: session.user_id,
        sessionId: session.session_id,
        isAdmin: session.is_admin,
      };
    });

    /** Rotas `/v1/admin/*` (D11): depois de `authenticate`, exige `is_admin`. */
    fastify.decorate('requireAdmin', async function requireAdmin(request: FastifyRequest) {
      if (!request.auth) throw new Unauthenticated();
      if (!request.auth.isAdmin) throw new Forbidden();
    });

    fastify.decorate(
      'authorizeCondominium',
      async function authorizeCondominium(request: FastifyRequest) {
        if (!request.auth) throw new Unauthenticated();
        const { cid } = request.params as { cid?: string };
        if (!cid || !UUID.test(cid)) throw new CondominiumNotFound();

        const membership = await fastify.membershipsRepository.findActive(request.auth.userId, cid);
        if (!membership) throw new CondominiumNotFound();

        const rule = request.routeOptions.config.access ?? DEFAULT_ACCESS;
        const statuses = rule.statuses ?? ['approved'];
        if (!statuses.includes(membership.status)) {
          if (membership.status === 'pending') throw new MembershipPending();
          if (membership.status === 'rejected') throw new MembershipRejected();
          throw new Forbidden();
        }
        if (!rule.roles.includes(membership.role)) throw new Forbidden();

        request.membership = membership;
      },
    );
  },
  {
    name: 'authorization',
    dependencies: ['jwt', 'sessions-repository', 'memberships-repository'],
  },
);

export type AuthContext = { userId: string; sessionId: string; isAdmin: boolean };

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
    authorizeCondominium: (request: FastifyRequest) => Promise<void>;
    requireAdmin: (request: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    /** Preenchido por `authenticate`. */
    auth: AuthContext | null;
    /** Preenchido por `authorizeCondominium`: o vínculo do usuário com o `:cid` da rota. */
    membership: Membership | null;
  }
  interface FastifyContextConfig {
    access?: AccessRule;
  }
}
