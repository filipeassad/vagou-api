import { describe, expect, it } from 'vitest';
import {
  createEmailNotifier,
  type EmailMessage,
} from '../../../../src/plugins/app/notifications/email-notifier.ts';
import {
  renderMessage,
  type Notification,
} from '../../../../src/plugins/app/notifications/messages.ts';
import { buildTestApp, captureLogs, sentNotifications } from '../../../helper.ts';

const to = { name: 'Maria', email: 'maria@example.com' };
const passwordReset: Notification = {
  type: 'password_reset',
  to,
  resetUrl: 'http://localhost:5173/redefinir-senha?token=tok-secreto',
  expiresInMinutes: 30,
};

describe('notificador (D9)', () => {
  it('o app de teste captura a notificação enviada (NOTIFIER=memory)', async () => {
    const app = await buildTestApp();

    await app.notifier.send(passwordReset);

    expect(sentNotifications(app)).toEqual([passwordReset]);
    await app.close();
  });

  it('console imprime assunto e link no log, sem o e-mail do destinatário', async () => {
    const logs = captureLogs();
    const app = await buildTestApp({
      config: { NOTIFIER: 'console', LOG_LEVEL: 'info' },
      logStream: logs.stream,
    });

    await app.notifier.send(passwordReset);
    await app.close();

    const output = logs.text();
    expect(output).toContain('Redefinição de senha do Vagou');
    expect(output).toContain('tok-secreto');
    expect(output).not.toContain('maria@example.com');
  });

  it('NOTIFIER=email sem fornecedor integrado impede a API de subir', async () => {
    await expect(
      buildTestApp({ config: { NOTIFIER: 'email', EMAIL_FROM: 'Vagou <a@b.com>' } }),
    ).rejects.toThrow('fornecedor de e-mail ainda não integrado');
  });

  it('email monta a mensagem e entrega ao fornecedor', async () => {
    const delivered: EmailMessage[] = [];
    const notifier = createEmailNotifier({
      from: 'Vagou <nao-responda@vagou.com.br>',
      transport: { send: async (message) => void delivered.push(message) },
    });

    await notifier.send(passwordReset);

    expect(delivered).toEqual([
      {
        from: 'Vagou <nao-responda@vagou.com.br>',
        to: 'maria@example.com',
        subject: 'Redefinição de senha do Vagou',
        text: expect.stringContaining(passwordReset.resetUrl),
      },
    ]);
  });

  it('email repassa a falha do fornecedor para quem chamou', async () => {
    const notifier = createEmailNotifier({
      from: 'x@y.com',
      transport: {
        send: async () => {
          throw new Error('fornecedor fora do ar');
        },
      },
    });

    await expect(notifier.send(passwordReset)).rejects.toThrow('fornecedor fora do ar');
  });
});

describe('renderMessage', () => {
  const cases: Notification[] = [
    passwordReset,
    {
      type: 'manager_account_created',
      to,
      condominiumName: 'Residencial Aurora',
      setPasswordUrl: 'http://x/definir-senha?token=t1',
      appUrl: 'http://x/',
    },
    {
      type: 'manager_role_received',
      to,
      condominiumName: 'Residencial Aurora',
      appUrl: 'http://x/entrar',
    },
    {
      type: 'membership_pending',
      to,
      condominiumName: 'Residencial Aurora',
      residentName: 'João',
      unitLabel: 'Bloco A, 101',
      reviewUrl: 'http://x/sindico/cadastros',
    },
    {
      type: 'membership_approved',
      to,
      condominiumName: 'Residencial Aurora',
      appUrl: 'http://x/',
    },
    {
      type: 'invite',
      to,
      condominiumName: 'Residencial Aurora',
      inviteUrl: 'http://x/convite?token=t2',
      expiresAt: new Date('2026-12-01T02:30:00Z'),
    },
  ];

  it.each(cases)('$type tem assunto, saudação e o link', (notification) => {
    const { subject, text } = renderMessage(notification);
    const url = Object.entries(notification).find(([key]) => key.endsWith('Url'))?.[1];

    expect(subject.length).toBeGreaterThan(0);
    expect(text).toContain('Olá, Maria!');
    expect(text).toContain(url);
  });

  it('data do convite é exibida no fuso de São Paulo (02:30 UTC de 01/12 = 30/11)', () => {
    const { text } = renderMessage(cases.find((n) => n.type === 'invite')!);
    expect(text).toContain('30/11/2026');
  });

  it('síndico que já tinha senha recebe o link do app em vez do de definir senha', () => {
    const { text } = renderMessage({
      type: 'manager_account_created',
      to,
      condominiumName: 'Residencial Aurora',
      setPasswordUrl: null,
      appUrl: 'http://x/entrar',
    });
    expect(text).toContain('http://x/entrar');
    expect(text).not.toContain('definir a sua senha');
  });

  it('recusa mostra o motivo quando houver e omite a linha quando não houver', () => {
    const base = {
      type: 'membership_rejected',
      to,
      condominiumName: 'Residencial Aurora',
    } as const;

    expect(renderMessage({ ...base, reason: 'Unidade não confere' }).text).toContain(
      'Motivo: Unidade não confere',
    );
    expect(renderMessage({ ...base, reason: null }).text).not.toContain('Motivo');
  });
});
