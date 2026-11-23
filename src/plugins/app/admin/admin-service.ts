import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { generateOpaqueToken, hashOpaqueToken } from '../auth/opaque-token.ts';
import { PublicCodeTaken, type AdminCondominium } from '../condominiums/condominiums-repository.ts';
import { assertValidTimezone } from '../condominiums/timezones.ts';

/** Validade do link de definir senha do síndico criado pelo admin (req. 1). */
export const MANAGER_SETUP_TTL_DAYS = 7;

// Sem 0/O, 1/I/L: o código aparece no link do QR Code e pode ser digitado.
const PUBLIC_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PUBLIC_CODE_LENGTH = 8;

/** Código público do condomínio, usado no link do QR Code de cadastro (req. 6). */
export function generatePublicCode(): string {
  let code = '';
  for (let i = 0; i < PUBLIC_CODE_LENGTH; i++) {
    code += PUBLIC_CODE_ALPHABET[randomInt(PUBLIC_CODE_ALPHABET.length)];
  }
  return code;
}

/** Link de definir senha: mesmo token e rota do reset de senha (fragmento `#token=`). */
export function setPasswordUrl(webOrigin: string, token: string) {
  return `${webOrigin}/definir-senha#token=${token}`;
}

export type NewCondominiumInput = {
  name: string;
  address: string;
  timezone?: string;
  manager: { name: string; email: string; phone?: string | null };
};

/** Ações do admin da plataforma (spec 001, req. 1; plano 001, D11). */
export function createAdminService(fastify: FastifyInstance) {
  const { usersRepository, condominiumsRepository, notifier, config } = fastify;

  return {
    listCondominiums(): Promise<AdminCondominium[]> {
      return condominiumsRepository.listForAdmin();
    },

    /**
     * Cria o condomínio e o síndico. Se o e-mail já tem conta (ex.: morador de outro
     * condomínio), usa a mesma conta (req. 23). Quem ainda não tem senha recebe o link
     * de definir senha (7 dias); quem tem, só o aviso. O envio não é aguardado: se
     * falhar, o síndico ainda pode usar "Esqueci minha senha".
     */
    async createCondominium(input: NewCondominiumInput): Promise<AdminCondominium> {
      const timezone = input.timezone ?? 'America/Sao_Paulo';
      assertValidTimezone(timezone);

      const existing = await usersRepository.findCredentialsByEmail(input.manager.email);
      const token = existing?.password_hash ? null : generateOpaqueToken();

      let condominium: AdminCondominium | undefined;
      for (let attempt = 1; !condominium; attempt++) {
        try {
          condominium = await condominiumsRepository.createWithManager({
            name: input.name,
            address: input.address,
            timezone,
            publicCode: generatePublicCode(),
            manager: existing
              ? { userId: existing.id }
              : {
                  name: input.manager.name,
                  email: input.manager.email,
                  phone: input.manager.phone ?? null,
                },
            setupToken: token
              ? { hash: hashOpaqueToken(token), ttlMinutes: MANAGER_SETUP_TTL_DAYS * 24 * 60 }
              : null,
          });
        } catch (err) {
          if (err instanceof PublicCodeTaken && attempt < 3) continue;
          throw err;
        }
      }

      const manager = condominium.manager!;
      notifier
        .send({
          type: 'manager_account_created',
          to: { name: manager.name, email: manager.email },
          condominiumName: condominium.name,
          setPasswordUrl: token ? setPasswordUrl(config.WEB_ORIGIN, token) : null,
          appUrl: `${config.WEB_ORIGIN}/entrar`,
        })
        .catch((err: unknown) => {
          fastify.log.error(
            { err, userId: manager.id },
            'Falha ao enviar e-mail de boas-vindas ao síndico',
          );
        });

      fastify.log.info(
        { condominiumId: condominium.id, managerId: manager.id },
        'Condomínio cadastrado pelo admin',
      );
      return condominium;
    },
  };
}

export type AdminService = ReturnType<typeof createAdminService>;

export default fp(
  async function adminServicePlugin(fastify) {
    fastify.decorate('adminService', createAdminService(fastify));
  },
  {
    name: 'admin-service',
    dependencies: ['users-repository', 'condominiums-repository', 'notifier'],
  },
);

declare module 'fastify' {
  interface FastifyInstance {
    adminService: AdminService;
  }
}
