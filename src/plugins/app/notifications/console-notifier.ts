import type { FastifyBaseLogger } from 'fastify';
import { renderMessage, type Notifier } from './messages.ts';

// Só funções: o @fastify/autoload não registra este arquivo como plugin.
export const autoload = false;

/**
 * Imprime a notificação no log (NOTIFIER=console), para o desenvolvedor copiar o link.
 * O texto tem links com token, por isso a config proíbe este notificador em produção.
 * O e-mail do destinatário não é impresso (princípio VI).
 */
export function createConsoleNotifier(log: FastifyBaseLogger): Notifier {
  return {
    async send(notification) {
      const { subject, text } = renderMessage(notification);
      log.info(
        { notification: notification.type, to: notification.to.name, subject },
        `Notificação (console):\n${text}`,
      );
    },
  };
}
