import { renderMessage, type Notifier } from './messages.ts';

// Só funções: o @fastify/autoload não registra este arquivo como plugin.
export const autoload = false;

export type EmailMessage = { from: string; to: string; subject: string; text: string };

/**
 * Envio pelo fornecedor de e-mail (Cloudflare Email Service ou Resend, plano 001 seção 8).
 * A integração com o fornecedor implementa só esta interface, em
 * `src/plugins/external/`, quando for escolhido.
 */
export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

/** Notificador de produção (NOTIFIER=email): monta o e-mail e entrega ao fornecedor. */
export function createEmailNotifier({
  transport,
  from,
}: {
  transport: EmailTransport;
  from: string;
}): Notifier {
  return {
    async send(notification) {
      const { subject, text } = renderMessage(notification);
      await transport.send({ from, to: notification.to.email, subject, text });
    },
  };
}
