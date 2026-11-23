import fp from 'fastify-plugin';
import type { Db } from '../external/db.ts';

/** Eventos internos (plano 001, seção 6) e o que cada um carrega. */
export type AppEvents = {
  /** Síndico removeu um morador. Consumido pelos planos 002 (vagas) e 006 (reservas). */
  'membership.removed': {
    condominiumId: string;
    membershipId: string;
    userId: string;
    removedBy: string;
  };
};

type Handler<K extends keyof AppEvents> = (payload: AppEvents[K], trx: Db) => Promise<void>;

/**
 * Eventos síncronos, sem fila (princípio VIII). Os handlers rodam em ordem, dentro da
 * transação de quem emite (`trx`): se um falhar, a mudança inteira é desfeita, e o
 * morador não fica removido com as vagas ainda visíveis.
 */
export function createEvents() {
  const handlers: { [K in keyof AppEvents]?: Handler<K>[] } = {};

  return {
    /** Registra um handler. Devolve a função que o remove (útil nos testes). */
    on<K extends keyof AppEvents>(name: K, handler: Handler<K>): () => void {
      const list = (handlers[name] ??= []) as Handler<K>[];
      list.push(handler);
      return () => {
        list.splice(list.indexOf(handler), 1);
      };
    },

    async emit<K extends keyof AppEvents>(name: K, payload: AppEvents[K], trx: Db) {
      for (const handler of (handlers[name] ?? []) as Handler<K>[]) {
        await handler(payload, trx);
      }
    },
  };
}

export type Events = ReturnType<typeof createEvents>;

export default fp(
  async function eventsPlugin(fastify) {
    fastify.decorate('events', createEvents());
  },
  { name: 'events' },
);

declare module 'fastify' {
  interface FastifyInstance {
    events: Events;
  }
}
