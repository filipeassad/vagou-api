import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { createConsoleNotifier } from './console-notifier.ts';
import type { Notifier } from './messages.ts';
import { createMemoryNotifier } from './memory-notifier.ts';

/**
 * `fastify.notifier` (D9): o resto da app só conhece a interface `Notifier`; a
 * implementação vem de `NOTIFIER`. Ver `messages.ts` para os tipos de notificação.
 */
export default fp(
  async function notifierPlugin(fastify) {
    fastify.decorate('notifier', createNotifier(fastify));
  },
  { name: 'notifier' },
);

function createNotifier(fastify: FastifyInstance): Notifier {
  switch (fastify.config.NOTIFIER) {
    case 'console':
      return createConsoleNotifier(fastify.log);
    case 'memory':
      return createMemoryNotifier();
    case 'email':
      // Esqueleto: createEmailNotifier({ transport, from: config.EMAIL_FROM }) entra aqui
      // quando o fornecedor for escolhido (antes do deploy).
      throw new Error('NOTIFIER=email: fornecedor de e-mail ainda não integrado (plano 001, D9)');
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    notifier: Notifier;
  }
}
