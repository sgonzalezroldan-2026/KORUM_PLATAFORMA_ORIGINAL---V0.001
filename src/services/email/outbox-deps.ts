import { getEnv } from '@/config/env';
import type { Db } from '@/lib/db';
import type { OutboxDeps } from './outbox-processor';
import { getEmailProvider, resolveEmailSender } from './provider-factory';

/**
 * Lo que la bandeja de salida necesita de fuera, resuelto solo al enviar: el proveedor y el remitente salen de la consola del
 * Super-Admin (`/admin/ajustes`), y la URL y el secreto del QR, del entorno. La comparten la tarea `OUTBOX_DISPATCH` y el envío inmediato
 * tras un pago confirmado.
 */
export function buildOutboxDeps(db: Db): OutboxDeps {
  const env = getEnv();
  return {
    provider: () => getEmailProvider(db),
    sender: () => resolveEmailSender(db),
    appUrl: () => env.NEXT_PUBLIC_APP_URL,
    qrSecret: () => env.QR_HMAC_SECRET
  };
}
