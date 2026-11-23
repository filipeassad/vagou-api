import createError from '@fastify/error';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ACCESS_TOKEN_TTL_SECONDS } from '../../external/jwt.ts';
import { generateOpaqueToken, hashOpaqueToken } from './opaque-token.ts';
import { SessionAlreadyRotated, type NewSession } from './sessions-repository.ts';

/** Regras de login (spec 001, req. 20 e 22; plano 001, D5). */
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_LOCK_MINUTES = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
export const REFRESH_TTL_DAYS = 90;
/** Portaria usa computador compartilhado: sessão mais curta (revisão do plano, D5). */
export const FRONT_DESK_REFRESH_TTL_DAYS = 30;

/** Mesma mensagem para e-mail inexistente e senha errada: não revela quem tem conta. */
export const InvalidCredentials = createError(
  'INVALID_CREDENTIALS',
  'E-mail ou senha incorretos.',
  401,
);

export const LoginBlocked = createError(
  'LOGIN_BLOCKED',
  `Muitas tentativas erradas. Aguarde ${LOGIN_LOCK_MINUTES} minutos ou use "Esqueci minha senha".`,
  429,
);

/**
 * Refresh token inválido, vencido, revogado ou reusado. Uma só mensagem para todos os
 * casos: o cliente só precisa saber que deve pedir login de novo.
 */
export const InvalidRefreshToken = createError(
  'INVALID_REFRESH_TOKEN',
  'Sua sessão expirou. Entre novamente.',
  401,
);

/**
 * Janela de tolerância para duas requisições rotacionarem o mesmo refresh quase juntas
 * (ex.: duas abas do web). Dentro dela, a perdedora recebe 401 mas as sessões não caem:
 * no web o cookie já foi trocado pela vencedora. Fora dela, é reuso de token roubado.
 */
export const REFRESH_REUSE_GRACE_SECONDS = 10;

export type LoginResult = {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
};

export function createAuthService(fastify: FastifyInstance) {
  const { usersRepository, sessionsRepository, membershipsRepository, passwordManager } = fastify;

  // Hash de uma senha qualquer, para conferir mesmo quando o e-mail não existe: o tempo
  // de resposta fica parecido e não denuncia quais e-mails têm conta.
  const dummyHash = passwordManager.hash(generateOpaqueToken());

  /** Gera um refresh token novo e os dados da sessão (validade depende do perfil). */
  async function newSessionFor(userId: string, userAgent: string | null) {
    const ttlDays = (await membershipsRepository.isFrontDesk(userId))
      ? FRONT_DESK_REFRESH_TTL_DAYS
      : REFRESH_TTL_DAYS;
    const refreshToken = generateOpaqueToken();
    const input: NewSession = {
      userId,
      refreshTokenHash: hashOpaqueToken(refreshToken),
      expiresAt: new Date(Date.now() + ttlDays * DAY_MS),
      userAgent,
    };
    return { refreshToken, input };
  }

  function tokensFor(
    session: { id: string; user_id: string; expires_at: Date },
    refreshToken: string,
  ): LoginResult {
    return {
      accessToken: fastify.jwt.sign({ sub: session.user_id, sid: session.id }),
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      refreshExpiresAt: session.expires_at,
    };
  }

  return {
    async login(input: {
      email: string;
      password: string;
      userAgent: string | null;
    }): Promise<LoginResult> {
      const user = await usersRepository.findCredentialsByEmail(input.email);

      if (!user || !user.password_hash) {
        await passwordManager.verify(await dummyHash, input.password);
        throw new InvalidCredentials();
      }

      // Bloqueada: nem confere a senha (nem a certa entra até o bloqueio acabar).
      if (user.locked_until && user.locked_until > new Date()) {
        throw new LoginBlocked();
      }

      if (!(await passwordManager.verify(user.password_hash, input.password))) {
        const { locked } = await usersRepository.recordFailedLogin(user.id, {
          maxAttempts: LOGIN_MAX_ATTEMPTS,
          lockMinutes: LOGIN_LOCK_MINUTES,
        });
        throw locked ? new LoginBlocked() : new InvalidCredentials();
      }

      if (user.failed_login_attempts > 0 || user.locked_until) {
        await usersRepository.resetFailedLogins(user.id);
      }
      const { refreshToken, input: sessionInput } = await newSessionFor(user.id, input.userAgent);
      const session = await sessionsRepository.create(sessionInput);
      return tokensFor(session, refreshToken);
    },

    /**
     * Troca o refresh token por um par novo (rotação, plano 001 D5). O token antigo para
     * de valer. Se um token já trocado aparecer de novo depois da janela de tolerância,
     * alguém o copiou: todas as sessões do usuário são encerradas (detecção de reuso).
     */
    async refresh(input: { refreshToken: string; userAgent: string | null }): Promise<LoginResult> {
      const session = await sessionsRepository.findByRefreshTokenHash(
        hashOpaqueToken(input.refreshToken),
      );
      if (!session) throw new InvalidRefreshToken();

      if (session.revoked_at) {
        const rotatedJustNow =
          session.replaced_by !== null &&
          Date.now() - session.revoked_at.getTime() < REFRESH_REUSE_GRACE_SECONDS * 1000;
        if (session.replaced_by !== null && !rotatedJustNow) {
          const revoked = await sessionsRepository.revokeAllForUser(session.user_id);
          fastify.log.warn(
            { userId: session.user_id, sessionId: session.id, revokedSessions: revoked },
            'Reuso de refresh token: todas as sessões do usuário foram encerradas',
          );
        }
        throw new InvalidRefreshToken();
      }

      if (session.expires_at <= new Date()) throw new InvalidRefreshToken();

      const { refreshToken, input: next } = await newSessionFor(session.user_id, input.userAgent);
      try {
        const created = await sessionsRepository.rotate(session.id, next);
        return tokensFor(created, refreshToken);
      } catch (err) {
        // Outra requisição rotacionou este token no mesmo instante: tratada como a
        // corrida benigna da janela de tolerância.
        if (err instanceof SessionAlreadyRotated) throw new InvalidRefreshToken();
        throw err;
      }
    },

    /** Encerra a sessão do refresh token informado. Token desconhecido: não faz nada. */
    async logout(refreshToken: string): Promise<void> {
      const session = await sessionsRepository.findByRefreshTokenHash(
        hashOpaqueToken(refreshToken),
      );
      if (session) await sessionsRepository.revoke(session.id);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;

export default fp(
  async function authServicePlugin(fastify) {
    fastify.decorate('authService', createAuthService(fastify));
  },
  {
    name: 'auth-service',
    dependencies: [
      'jwt',
      'users-repository',
      'sessions-repository',
      'memberships-repository',
      'password-manager',
    ],
  },
);

declare module 'fastify' {
  interface FastifyInstance {
    authService: AuthService;
  }
}
