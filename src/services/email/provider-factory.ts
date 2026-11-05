import { getEnv } from '@/config/env';
import { getKeyring } from '@/config/keyring';
import type { Keyring } from '@/core/security/crypto';
import type { Db } from '@/lib/db';
import { getSecret, getSetting } from '@/services/settings/settings.service';
import { BrevoEmailProvider } from './brevo-email-provider';
import { EmailConfigurationError, type EmailProvider } from './email-provider';
import { PreviewEmailProvider } from './preview-email-provider';

/** Remitente efectivo, leído de la consola del Super-Admin (`email.fromAddress`, `email.fromName`, `email.replyTo`). */
export interface EmailSender {
  fromAddress: string;
  fromName: string;
  replyTo?: string;
}

export async function resolveEmailSender(db: Db): Promise<EmailSender | undefined> {
  const fromAddress = await getSetting(db, 'email.fromAddress');
  if (!fromAddress) return undefined;
  const replyTo = await getSetting(db, 'email.replyTo');
  return { fromAddress, fromName: (await getSetting(db, 'email.fromName')) ?? 'KORUM', ...(replyTo ? { replyTo } : {}) };
}

/**
 * Elige cómo se envían los emails. Con `PAYCOMET_MODE=mock` (desarrollo, pruebas, demostración) siempre es la vista previa: nunca sale
 * un email real desde un entorno con cobros simulados. Con `sandbox` o `live` hace falta el proveedor configurado en la consola; si falta
 * algo, la bandeja no pierde nada: los mensajes esperan y se alerta.
 */
export async function getEmailProvider(db: Db, keyring: Keyring = getKeyring()): Promise<EmailProvider> {
  if (getEnv().PAYCOMET_MODE === 'mock') return new PreviewEmailProvider();
  const provider = await getSetting(db, 'email.provider');
  if (provider === 'brevo') {
    const apiKey = await getSecret(db, keyring, 'email.apiKey');
    if (!apiKey) throw new EmailConfigurationError(['email.apiKey']);
    return new BrevoEmailProvider(apiKey);
  }
  // SMTP figura en el catálogo de ajustes pero no tiene adaptador todavía (la ficha 2.6 solo exige el proveedor elegido: Brevo).
  throw new EmailConfigurationError(['email.provider (solo «brevo» tiene adaptador)']);
}
