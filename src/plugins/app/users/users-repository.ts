import createError from '@fastify/error';
import fp from 'fastify-plugin';
import { sql, type Selectable } from 'kysely';
import { isUniqueViolation, type Db } from '../../external/db.ts';
import type { Users } from '../../external/db-types.ts';

/** E-mail já usado por outra conta (req. 23). Comparação sem diferenciar maiúsculas. */
export const EmailAlreadyRegistered = createError(
  'EMAIL_ALREADY_REGISTERED',
  'Este e-mail já está cadastrado. Entre com sua senha ou use "Esqueci minha senha".',
  409,
);

/** Dados do usuário que podem sair da API: nunca inclui o hash da senha. */
export type User = Omit<
  Selectable<Users>,
  'password_hash' | 'failed_login_attempts' | 'locked_until'
>;

/** Usado só pela autenticação (login), que precisa do hash e do bloqueio. */
export type UserCredentials = Selectable<Users>;

export type NewUser = {
  name: string;
  email: string;
  phone: string | null;
  /** null para o síndico criado pelo admin, que define a senha depois (req. 1). */
  passwordHash: string | null;
  isAdmin?: boolean;
};

const PUBLIC_COLUMNS = ['id', 'name', 'email', 'phone', 'is_admin', 'created_at'] as const;

export function normalizeEmail(email: string) {
  return email.trim();
}

export function createUsersRepository(db: Db) {
  return {
    async create(input: NewUser): Promise<User> {
      try {
        return await db
          .insertInto('users')
          .values({
            name: input.name.trim(),
            email: normalizeEmail(input.email),
            phone: input.phone,
            password_hash: input.passwordHash,
            is_admin: input.isAdmin ?? false,
          })
          .returning(PUBLIC_COLUMNS)
          .executeTakeFirstOrThrow();
      } catch (err) {
        if (isUniqueViolation(err, 'users_email_key')) throw new EmailAlreadyRegistered();
        throw err;
      }
    },

    findById(id: string): Promise<User | undefined> {
      return db.selectFrom('users').select(PUBLIC_COLUMNS).where('id', '=', id).executeTakeFirst();
    },

    /** A coluna é citext: "Maria@Example.com" e "maria@example.com" são o mesmo e-mail. */
    findCredentialsByEmail(email: string): Promise<UserCredentials | undefined> {
      return db
        .selectFrom('users')
        .selectAll()
        .where('email', '=', normalizeEmail(email))
        .executeTakeFirst();
    },

    /**
     * Conta uma senha errada (req. 22). Ao chegar em `maxAttempts`, bloqueia por
     * `lockMinutes` e zera o contador. Feito num único UPDATE para duas tentativas
     * simultâneas não se perderem. Devolve se a conta ficou bloqueada agora.
     */
    async recordFailedLogin(
      id: string,
      { maxAttempts, lockMinutes }: { maxAttempts: number; lockMinutes: number },
    ): Promise<{ locked: boolean }> {
      const row = await db
        .updateTable('users')
        .set({
          failed_login_attempts: sql`case when failed_login_attempts + 1 >= ${maxAttempts}
            then 0 else failed_login_attempts + 1 end`,
          locked_until: sql`case when failed_login_attempts + 1 >= ${maxAttempts}
            then now() + make_interval(mins => ${lockMinutes}) else locked_until end`,
        })
        .where('id', '=', id)
        .returning('locked_until')
        .executeTakeFirst();
      return { locked: row?.locked_until != null && row.locked_until > new Date() };
    },

    /** Login certo: zera as tentativas e o bloqueio. */
    async resetFailedLogins(id: string): Promise<void> {
      await db
        .updateTable('users')
        .set({ failed_login_attempts: 0, locked_until: null })
        .where('id', '=', id)
        .execute();
    },
  };
}

export type UsersRepository = ReturnType<typeof createUsersRepository>;

export default fp(
  async function usersRepositoryPlugin(fastify) {
    fastify.decorate('usersRepository', createUsersRepository(fastify.db));
  },
  { name: 'users-repository', dependencies: ['db'] },
);

declare module 'fastify' {
  interface FastifyInstance {
    usersRepository: UsersRepository;
  }
}
