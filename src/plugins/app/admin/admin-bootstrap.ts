import type { Db } from '../../external/db.ts';
import { generateOpaqueToken, hashOpaqueToken } from '../auth/opaque-token.ts';
import { createPasswordResetsRepository } from '../auth/password-resets-repository.ts';
import { createUsersRepository } from '../users/users-repository.ts';

// Só funções (usado por scripts/create-admin.ts): o autoload não registra como plugin.
export const autoload = false;

/** Validade do link de definir senha impresso pelo `npm run admin:criar`. */
export const ADMIN_SETUP_TTL_MINUTES = 24 * 60;

/**
 * Cria o admin da plataforma (D11) ou promove uma conta existente. Quem ainda não tem
 * senha ganha um token de definir senha, que o script imprime no terminal (não passa
 * por e-mail nem por log).
 */
export async function bootstrapAdmin(
  db: Db,
  input: { name: string; email: string },
): Promise<{ userId: string; created: boolean; setupToken: string | null }> {
  const users = createUsersRepository(db);
  const existing = await users.findCredentialsByEmail(input.email);

  let userId: string;
  if (existing) {
    await db.updateTable('users').set({ is_admin: true }).where('id', '=', existing.id).execute();
    userId = existing.id;
  } else {
    const user = await users.create({
      name: input.name,
      email: input.email,
      phone: null,
      passwordHash: null,
      isAdmin: true,
    });
    userId = user.id;
  }

  let setupToken: string | null = null;
  if (!existing?.password_hash) {
    setupToken = generateOpaqueToken();
    await createPasswordResetsRepository(db).create({
      userId,
      tokenHash: hashOpaqueToken(setupToken),
      ttlMinutes: ADMIN_SETUP_TTL_MINUTES,
    });
  }

  return { userId, created: !existing, setupToken };
}
