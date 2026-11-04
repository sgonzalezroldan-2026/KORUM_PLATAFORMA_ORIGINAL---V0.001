import { getEnv } from '@/config/env';
import type { Db } from '@/lib/db';
import { getInvoicingProvider } from '@/services/invoicing/provider-factory';
import { getPaymentProvider, PaymentConfigurationError } from '@/services/payments/provider-factory';
import type { JobDeps } from './job-types';

/** Ajuste de la consola con la IP pública del servidor que llama a Paycomet: la API de devoluciones la pide como «IP de la aplicación del negocio». */
export const SERVER_IP_SETTING = 'paycomet.serverIp';
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
    refundOriginalIp: async () => {
      const setting = await db.platformSetting.findUnique({ where: { key: SERVER_IP_SETTING } });
      if (typeof setting?.valueJson === 'string' && setting.valueJson.length > 0) return setting.valueJson;
      if (env.PAYCOMET_MODE === 'mock') return MOCK_SERVER_IP;
      throw new PaymentConfigurationError([SERVER_IP_SETTING]);
    }
  };
}
