import { getEnv } from '@/config/env';
import { getKeyring } from '@/config/keyring';
import type { Db } from '@/lib/db';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { getInvoicingProvider } from '@/services/invoicing/provider-factory';
import { getPaymentProvider, PaymentConfigurationError } from '@/services/payments/provider-factory';
import { getSetting } from '@/services/settings/settings.service';
import { getStorageProvider } from '@/services/storage/provider-factory';
import type { JobDeps } from './job-types';

/** Ajuste de la consola con la IP pública del servidor que llama a Paycomet: la API de devoluciones la pide como «IP de la aplicación del negocio». */
export const SERVER_IP_SETTING = 'paycomet.serverIp' as const;
const MOCK_SERVER_IP = '127.0.0.1';

/**
 * Lo que las tareas programadas necesitan de fuera, resuelto solo cuando se usa. La IP del servidor sale de `/admin/ajustes`; en el
 * simulador basta la local, pero con `sandbox` o `live` sin configurar la tarea falla a propósito en lugar de inventar una.
 */
export function buildJobDeps(db: Db): JobDeps {
  const env = getEnv();
  return {
    paymentProvider: () => getPaymentProvider(db),
    invoicingProvider: () => getInvoicingProvider(env.PAYCOMET_MODE),
    storageProvider: () => getStorageProvider(),
    keyring: () => getKeyring(),
    hmacSecret: () => env.DATA_HMAC_SECRET,
    outbox: buildOutboxDeps(db),
    refundOriginalIp: async () => {
      const serverIp = await getSetting(db, SERVER_IP_SETTING);
      if (serverIp) return serverIp;
      if (env.PAYCOMET_MODE === 'mock') return MOCK_SERVER_IP;
      throw new PaymentConfigurationError([SERVER_IP_SETTING]);
    }
  };
}
