// Só tipos e funções: o @fastify/autoload não registra este arquivo como plugin.
export const autoload = false;

/** Quem recebe. O e-mail nunca vai para log (princípio VI). */
export type Recipient = { name: string; email: string };

/**
 * Notificações do plano 001 (D9). Cada tarefa que envia uma notificação usa o tipo
 * dela; links já chegam prontos (com o token), montados a partir de `WEB_ORIGIN`.
 */
export type Notification =
  // T10: esqueci minha senha
  | { type: 'password_reset'; to: Recipient; resetUrl: string; expiresInMinutes: number }
  // T12: admin cadastrou o condomínio. setPasswordUrl é null quando o síndico já tinha
  // conta com senha (entra direto pelo appUrl).
  | {
      type: 'manager_account_created';
      to: Recipient;
      condominiumName: string;
      setPasswordUrl: string | null;
      appUrl: string;
    }
  // T15: o papel de síndico foi passado para este morador
  | { type: 'manager_role_received'; to: Recipient; condominiumName: string; appUrl: string }
  // T16: morador se cadastrou pelo link público; o síndico precisa aprovar
  | {
      type: 'membership_pending';
      to: Recipient;
      condominiumName: string;
      residentName: string;
      unitLabel: string;
      reviewUrl: string;
    }
  // T17: síndico aprovou ou recusou o cadastro
  | { type: 'membership_approved'; to: Recipient; condominiumName: string; appUrl: string }
  | { type: 'membership_rejected'; to: Recipient; condominiumName: string; reason: string | null }
  // T19: convite enviado pela plataforma
  | {
      type: 'invite';
      to: Recipient;
      condominiumName: string;
      inviteUrl: string;
      expiresAt: Date;
    };

export type NotificationType = Notification['type'];

export interface Notifier {
  /** Envia a notificação. Falha do fornecedor vira exceção; quem chama decide o que fazer. */
  send(notification: Notification): Promise<void>;
}

/** Assunto e texto (pt-BR) de cada notificação. Usado pelo e-mail e pelo console. */
export function renderMessage(notification: Notification): { subject: string; text: string } {
  const hello = `Olá, ${notification.to.name}!`;
  switch (notification.type) {
    case 'password_reset':
      return {
        subject: 'Redefinição de senha do Vagou',
        text: lines(
          hello,
          'Recebemos um pedido para redefinir a sua senha. Para criar uma nova, acesse:',
          notification.resetUrl,
          `O link vale por ${notification.expiresInMinutes} minutos e só pode ser usado uma vez.`,
          'Se não foi você, ignore este e-mail: a sua senha continua a mesma.',
        ),
      };
    case 'manager_account_created':
      return {
        subject: `${notification.condominiumName} está no Vagou`,
        text: lines(
          hello,
          `Você foi cadastrado como síndico do ${notification.condominiumName} no Vagou.`,
          ...(notification.setPasswordUrl
            ? [
                'Para definir a sua senha e entrar, acesse (o link vale 7 dias):',
                notification.setPasswordUrl,
              ]
            : ['Entre com a sua senha de sempre:', notification.appUrl]),
        ),
      };
    case 'manager_role_received':
      return {
        subject: `Você é o novo síndico do ${notification.condominiumName} no Vagou`,
        text: lines(
          hello,
          `O papel de síndico do ${notification.condominiumName} foi passado para você no Vagou.`,
          'Agora você aprova cadastros, gera convites e cuida dos blocos e unidades em:',
          notification.appUrl,
        ),
      };
    case 'membership_pending':
      return {
        subject: `Novo cadastro aguardando aprovação: ${notification.residentName}`,
        text: lines(
          hello,
          `${notification.residentName} (${notification.unitLabel}) pediu acesso ao ${notification.condominiumName}.`,
          'Para aprovar ou recusar, acesse:',
          notification.reviewUrl,
        ),
      };
    case 'membership_approved':
      return {
        subject: `Cadastro aprovado no ${notification.condominiumName}`,
        text: lines(
          hello,
          `O síndico aprovou o seu cadastro no ${notification.condominiumName}. Já dá para usar o Vagou:`,
          notification.appUrl,
        ),
      };
    case 'membership_rejected':
      return {
        subject: `Cadastro não aprovado no ${notification.condominiumName}`,
        text: lines(
          hello,
          `O síndico não aprovou o seu cadastro no ${notification.condominiumName}.`,
          notification.reason ? `Motivo: ${notification.reason}` : null,
          'Em caso de dúvida, fale com o síndico.',
        ),
      };
    case 'invite':
      return {
        subject: `Convite para o ${notification.condominiumName} no Vagou`,
        text: lines(
          hello,
          `Você foi convidado para usar o Vagou no ${notification.condominiumName}. Para entrar, acesse:`,
          notification.inviteUrl,
          `O convite vale até ${formatDate(notification.expiresAt)}.`,
        ),
      };
  }
}

function lines(...parts: (string | null)[]): string {
  return parts.filter((part) => part !== null).join('\n\n');
}

// Exibição no fuso do condomínio (padrão America/Sao_Paulo, restrições técnicas).
function formatDate(date: Date): string {
  return date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
