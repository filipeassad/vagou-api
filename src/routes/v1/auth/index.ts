import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { InvalidRefreshToken, type LoginResult } from '../../../plugins/app/auth/auth-service.ts';
import {
  ForgotPasswordBody,
  LoginBody,
  RefreshBody,
  ResetPasswordBody,
  TokenResponse,
} from '../../../schemas/auth.ts';

/** Nome e caminho do cookie do refresh token no web (plano 001, D6). */
export const REFRESH_COOKIE = 'vagou_refresh';
const REFRESH_COOKIE_PATH = '/v1/auth';

const ErrorRef = Type.Ref('ErrorResponse');

// /v1/auth/...
const authRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const secureCookie = fastify.config.NODE_ENV !== 'development';

  function setRefreshCookie(reply: FastifyReply, result: LoginResult) {
    reply.setCookie(REFRESH_COOKIE, result.refreshToken, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      expires: result.refreshExpiresAt,
    });
  }

  function clearRefreshCookie(reply: FastifyReply) {
    reply.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    });
  }

  /** Mobile manda o refresh no corpo; o web, no cookie. O corpo tem precedência. */
  function readRefreshToken(request: FastifyRequest<{ Body: RefreshBody }>) {
    const fromBody = request.body.refresh_token;
    if (fromBody) return { token: fromBody, client: 'mobile' as const };
    const fromCookie = request.cookies[REFRESH_COOKIE];
    if (fromCookie) return { token: fromCookie, client: 'web' as const };
    return undefined;
  }

  function tokenResponse(result: LoginResult, client: 'web' | 'mobile') {
    return {
      access_token: result.accessToken,
      token_type: 'Bearer' as const,
      expires_in: result.expiresIn,
      ...(client === 'mobile' && { refresh_token: result.refreshToken }),
    };
  }

  /** O web chama refresh/logout sem corpo (só o cookie): trata corpo ausente como `{}`. */
  async function defaultEmptyBody(request: FastifyRequest) {
    request.body ??= {};
  }

  fastify.post(
    '/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Entrar com e-mail e senha',
        description:
          'Devolve o access token (15 min) e cria uma sessão. Após 5 senhas erradas seguidas a conta fica bloqueada por 15 minutos (LOGIN_BLOCKED). Limite de 10 tentativas por minuto por IP (RATE_LIMITED).',
        body: LoginBody,
        response: { 200: TokenResponse, 400: ErrorRef, 401: ErrorRef, 429: ErrorRef },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { email, password, client = 'web' } = request.body;
      const result = await fastify.authService.login({
        email,
        password,
        userAgent: request.headers['user-agent'] ?? null,
      });
      if (client === 'web') setRefreshCookie(reply, result);
      return tokenResponse(result, client);
    },
  );

  fastify.post(
    '/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Trocar o refresh token por um par novo',
        description:
          'Web: sem corpo, usa o cookie e recebe o cookie novo. Mobile: envia { refresh_token } e recebe o novo no corpo. O refresh antigo para de valer; reusar um refresh já trocado encerra todas as sessões do usuário.',
        body: RefreshBody,
        response: { 200: TokenResponse, 401: ErrorRef, 429: ErrorRef },
      },
      preValidation: defaultEmptyBody,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const received = readRefreshToken(request);
      if (!received) throw new InvalidRefreshToken();
      try {
        const result = await fastify.authService.refresh({
          refreshToken: received.token,
          userAgent: request.headers['user-agent'] ?? null,
        });
        if (received.client === 'web') setRefreshCookie(reply, result);
        return tokenResponse(result, received.client);
      } catch (err) {
        if (
          received.client === 'web' &&
          (err as { code?: string }).code === 'INVALID_REFRESH_TOKEN'
        ) {
          clearRefreshCookie(reply);
        }
        throw err;
      }
    },
  );

  fastify.post(
    '/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Sair: encerra a sessão deste aparelho',
        description:
          'Web: sem corpo, usa o cookie (e o apaga). Mobile: envia { refresh_token }. Sempre responde 204, mesmo se a sessão já tiver acabado.',
        body: RefreshBody,
        response: { 204: Type.Null({ description: 'Sessão encerrada' }) },
      },
      preValidation: defaultEmptyBody,
    },
    async (request, reply) => {
      const received = readRefreshToken(request);
      if (received) await fastify.authService.logout(received.token);
      clearRefreshCookie(reply);
      return reply.code(204).send(null);
    },
  );

  fastify.post(
    '/forgot-password',
    {
      schema: {
        tags: ['auth'],
        summary: 'Esqueci minha senha: envia o link de redefinição por e-mail',
        description:
          'Sempre responde 202, tenha o e-mail conta ou não (não revela quem é cadastrado). O link vale 30 minutos, só o mais recente funciona e sai no máximo um por minuto por conta. Limite de 5 pedidos por minuto por IP.',
        body: ForgotPasswordBody,
        response: {
          202: Type.Null({ description: 'Pedido recebido' }),
          400: ErrorRef,
          429: ErrorRef,
        },
      },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      await fastify.passwordResetService.requestReset(request.body.email);
      return reply.code(202).send(null);
    },
  );

  fastify.post(
    '/reset-password',
    {
      schema: {
        tags: ['auth'],
        summary: 'Definir a senha nova com o token do e-mail',
        description:
          'O token é de uso único. Encerra todas as sessões do usuário (todos os aparelhos precisam entrar de novo) e desfaz o bloqueio de login. Não faz login: o cliente leva para a tela de entrar.',
        body: ResetPasswordBody,
        response: {
          204: Type.Null({ description: 'Senha alterada' }),
          400: ErrorRef,
          429: ErrorRef,
        },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      await fastify.passwordResetService.resetPassword(request.body.token, request.body.password);
      return reply.code(204).send(null);
    },
  );
};

export default authRoutes;
