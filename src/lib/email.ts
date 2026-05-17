import { Resend } from 'resend';

import { env } from './env.js';
import { logger } from './logger.js';

let cachedClient: Resend | null = null;
let warnedAboutMissing = false;

function getClient(): Resend | null {
  if (cachedClient) return cachedClient;
  if (!env.RESEND_API_KEY) {
    if (!warnedAboutMissing) {
      logger.warn('RESEND_API_KEY not set — email sends will be no-ops');
      warnedAboutMissing = true;
    }
    return null;
  }
  cachedClient = new Resend(env.RESEND_API_KEY);
  return cachedClient;
}

export function isEmailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY);
}

interface SendParams {
  to: string;
  subject: string;
  html: string;
  text: string;
}

async function send(params: SendParams): Promise<void> {
  const client = getClient();
  if (!client) {
    logger.info(
      { to: params.to, subject: params.subject },
      'email skipped — no RESEND_API_KEY',
    );
    return;
  }
  try {
    const result = await client.emails.send({
      from: env.EMAIL_FROM,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    });
    if (result.error) {
      logger.error({ err: result.error, to: params.to }, 'resend send failed');
      return;
    }
    logger.info(
      { to: params.to, subject: params.subject, id: result.data?.id },
      'email sent',
    );
  } catch (err) {
    logger.error({ err, to: params.to }, 'resend send threw');
  }
}

// ---- shared template chrome --------------------------------------------------

const APP_NAME = 'OpenWritter';

function layout(opts: { heading: string; body: string; cta?: { url: string; label: string } }): {
  html: string;
  text: string;
} {
  const cta = opts.cta
    ? `<p style="margin: 32px 0;"><a href="${opts.cta.url}" style="background:#1f2937;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;display:inline-block;font-weight:500;">${opts.cta.label}</a></p>`
    : '';
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f7f7f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;">
  <div style="max-width:520px;margin:0 auto;padding:40px 24px;">
    <h1 style="font-size:22px;font-weight:600;margin:0 0 16px;">${opts.heading}</h1>
    <div style="font-size:15px;line-height:1.55;">${opts.body}</div>
    ${cta}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0 16px;">
    <p style="font-size:12px;color:#6b7280;margin:0;">${APP_NAME} — рабочее пространство для писателей.</p>
  </div>
</body></html>`;
  const text = `${opts.heading}\n\n${opts.body.replace(/<[^>]+>/g, '')}${
    opts.cta ? `\n\n${opts.cta.label}: ${opts.cta.url}` : ''
  }\n\n—\n${APP_NAME}`;
  return { html, text };
}

// ---- public senders ----------------------------------------------------------

export async function sendVerificationEmail(opts: {
  to: string;
  verifyUrl: string;
}): Promise<void> {
  const { html, text } = layout({
    heading: 'Подтвердите email',
    body: 'Чтобы завершить регистрацию в OpenWritter, нажмите кнопку ниже. Ссылка действует 1 час.',
    cta: { url: opts.verifyUrl, label: 'Подтвердить email' },
  });
  await send({ to: opts.to, subject: 'Подтверждение email — OpenWritter', html, text });
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  resetUrl: string;
}): Promise<void> {
  const { html, text } = layout({
    heading: 'Сброс пароля',
    body: 'Кто-то запросил сброс пароля для вашего аккаунта. Если это были не вы — просто проигнорируйте это письмо. Ссылка действует 1 час.',
    cta: { url: opts.resetUrl, label: 'Создать новый пароль' },
  });
  await send({ to: opts.to, subject: 'Сброс пароля — OpenWritter', html, text });
}

export async function sendTwoFactorEnabledEmail(opts: { to: string }): Promise<void> {
  const { html, text } = layout({
    heading: 'Двухфакторная аутентификация включена',
    body: 'Двухфакторная аутентификация (2FA) только что была включена для вашего аккаунта. Если это были не вы — немедленно смените пароль и отключите 2FA из настроек.',
  });
  await send({
    to: opts.to,
    subject: '2FA включена — OpenWritter',
    html,
    text,
  });
}

export async function sendTwoFactorDisabledEmail(opts: { to: string }): Promise<void> {
  const { html, text } = layout({
    heading: 'Двухфакторная аутентификация выключена',
    body: 'Двухфакторная аутентификация была отключена для вашего аккаунта. Если это были не вы — смените пароль и снова включите 2FA из настроек.',
  });
  await send({
    to: opts.to,
    subject: '2FA выключена — OpenWritter',
    html,
    text,
  });
}

export async function sendBackupCodeUsedEmail(opts: { to: string }): Promise<void> {
  const { html, text } = layout({
    heading: 'Использован резервный код 2FA',
    body: 'Только что был использован резервный код для входа в ваш аккаунт. Если это были не вы — немедленно смените пароль.',
  });
  await send({
    to: opts.to,
    subject: 'Использован резервный код — OpenWritter',
    html,
    text,
  });
}
