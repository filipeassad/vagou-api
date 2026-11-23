import type { Notification, Notifier } from './messages.ts';

// Só funções: o @fastify/autoload não registra este arquivo como plugin.
export const autoload = false;

export type MemoryNotifier = Notifier & { readonly sent: Notification[] };

/** Guarda as notificações na memória, para os testes conferirem (NOTIFIER=memory). */
export function createMemoryNotifier(): MemoryNotifier {
  const sent: Notification[] = [];
  return {
    sent,
    async send(notification) {
      sent.push(notification);
    },
  };
}

export function isMemoryNotifier(notifier: Notifier): notifier is MemoryNotifier {
  return Array.isArray((notifier as Partial<MemoryNotifier>).sent);
}
