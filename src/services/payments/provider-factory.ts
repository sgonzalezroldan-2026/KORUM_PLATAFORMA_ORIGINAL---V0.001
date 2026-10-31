import { createHmac } from 'node:crypto';
import { getEnv } from '@/config/env';
import type { Db } from '@/lib/db';
import { decryptParts } from '@/lib/encryption';
import { MockPaycometProvider } from './mock-paycomet';
import { PaycometAdapter, type PaycometCredentials } from './paycomet.adapter';
import type { NotificationSecrets } from './paycomet-notification';
import type { PaymentProvider } from './payment-provider';

/**
 * Elige la entidad de pago según `PAYCOMET_MODE`. Las credenciales salen de la consola del Super-Admin (`PlatformSecret`,
 * `PlatformSetting`) y, si aún no tienen valor, de las variables de respaldo: la consola siempre tiene prioridad (Regla 01 §5).
 */

export class PaymentConfigurationError extends Error {
  constructor(missing: string[]) {
    super(`Faltan credenciales de Paycomet: ${missing.join(', ')}. Configúralas en /admin/ajustes.`);
    this.name = 'PaymentConfigurationError';
  }
}

/** El contexto con el que se cifra cada secreto de la consola: es su propia clave. */
export const platformSecretContext = (key: string) => `platform-secret:${key}`;

async function readSecret(db: Db, key: string, encryptionKey: string, keyVersion: number): Promise<string | undefined> {
  const row = await db.platformSecret.findUnique({ where: { key } });
  if (!row) return undefined;
  if (row.keyVersion !== keyVersion) throw new RangeError(`El secreto ${key} está cifrado con la versión ${row.keyVersion} de la clave y la actual es la ${keyVersion}`);
  return decryptParts(row, encryptionKey, platformSecretContext(key));
}

async function readSetting(db: Db, key: string): Promise<string | undefined> {
  const row = await db.platformSetting.findUnique({ where: { key } });
  return typeof row?.valueJson === 'string' || typeof row?.valueJson === 'number' ? String(row.valueJson) : undefined;
}

export async function resolvePaycometCredentials(db: Db): Promise<PaycometCredentials> {
  const env = getEnv();
  const values = {
    apiKey: (await readSecret(db, 'paycomet.apiKey', env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_VERSION)) ?? env.PAYCOMET_API_KEY,
    notificationPassword: (await readSecret(db, 'paycomet.webhookSecret', env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_VERSION)) ?? env.PAYCOMET_WEBHOOK_SECRET,
    merchantCode: (await readSetting(db, 'paycomet.merchantCode')) ?? env.PAYCOMET_MERCHANT_CODE,
    terminal: (await readSetting(db, 'paycomet.terminalId')) ?? env.PAYCOMET_TERMINAL_ID
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) throw new PaymentConfigurationError(missing);
  return values as PaycometCredentials;
}

/**
 * Credenciales del simulador. La contraseña se deriva de un secreto del entorno y no está en el código: en un entorno de demostración
 * público, nadie puede fabricar notificaciones válidas para acreditar cobros falsos.
 */
export function mockNotificationSecrets(dataHmacSecret: string): NotificationSecrets {
  return { accountCode: 'KORUMOCK', terminal: '1', password: createHmac('sha256', dataHmacSecret).update('paycomet-mock-notifications').digest('hex') };
}

export async function getPaymentProvider(db: Db): Promise<PaymentProvider> {
  const env = getEnv();
  if (env.PAYCOMET_MODE === 'mock') return new MockPaycometProvider({ secrets: mockNotificationSecrets(env.DATA_HMAC_SECRET) });
  return new PaycometAdapter(env.PAYCOMET_MODE, await resolvePaycometCredentials(db));
}
