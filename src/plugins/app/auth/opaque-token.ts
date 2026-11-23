import { createHash, randomBytes } from 'node:crypto';

// Só funções: o @fastify/autoload não registra este arquivo como plugin.
export const autoload = false;

/**
 * Tokens opacos (refresh, convite, redefinição de senha), plano 001 D10:
 * 32 bytes aleatórios em base64url. O banco guarda só o hash SHA-256, então um
 * vazamento do banco não entrega tokens utilizáveis.
 */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOpaqueToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
