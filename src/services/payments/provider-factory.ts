import { createHmac } from 'node:crypto';
import { getEnv } from '@/config/env';
import { getKeyring } from '@/config/keyring';
import type { Keyring } from '@/core/security/crypto';
import type { Db } from '@/lib/db';
import { getSecret, getSetting } from '@/services/settings/settings.service';
import { MockPaycometProvider } from './mock-paycomet';
import { PaycometAdapter, type PaycometCredentials } from './paycomet.adapter';
import type { NotificationSecrets } from './paycomet-notification';
import type { PaymentProvider } from './payment-provider';

/**
 * Elige la entidad de pago según `PAYCOMET_MODE`. Las credenciales salen de la consola del Super-Admin (`PlatformSecret`,
 * `PlatformSetting`) y, si aún no tienen valor, de las variables de respaldo: la consola siempre tiene prioridad (Regla 01 §5).
 */

export class PaymentConfigurationError extends Error {
  constructor(readonly missing: string[]) {
    super(`Faltan credenciales de Paycomet: ${missing.join(', ')}. Configúralas en /admin/ajustes.`);
    this.name = 'PaymentConfigurationError';
  }
}

export async function resolvePaycometCredentials(db: Db, keyring: Keyring = getKeyring(), fallbacks?: Readonly<Record<string, string | undefined>>): Promise<PaycometCredentials> {
  // Consola primero y variables de respaldo después (lo resuelve el servicio de ajustes). Con el llavero, un secreto cifrado con una clave
  // anterior se sigue leyendo durante la rotación: cambiar `ENCRYPTION_KEY_VERSION` no deja sin webhooks.
  const values = {
    apiKey: await getSecret(db, keyring, 'paycomet.apiKey', fallbacks),
    notificationPassword: await getSecret(db, keyring, 'paycomet.webhookSecret', fallbacks),
    merchantCode: await getSetting(db, 'paycomet.merchantCode', fallbacks),
    terminal: await getSetting(db, 'paycomet.terminalId', fallbacks)
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
