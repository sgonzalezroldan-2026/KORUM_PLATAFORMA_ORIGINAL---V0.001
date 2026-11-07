import { QUEUED_TRANSACTION, type Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { applyPaymentNotification, type PaymentEventOptions } from './payment-events.service';
import type { PaymentProvider } from './payment-provider';
import { PaymentReconciliationError } from './payment-reversals';

/**
 * Recepción de notificaciones (Regla 01 §3, QA-P01). Una firma inválida responde 401 sin tocar ningún dato de negocio. Una entrega válida
 * se procesa una sola vez, aunque lleguen varias a la vez: quien se queda la fila de `WebhookEvent` hace el trabajo en esa misma
 * transacción, y si falla se deshace todo y la siguiente entrega puede reintentarlo.
 */

/** Las notificaciones de Paycomet son pequeñas: un cuerpo mayor no se lee ni se guarda. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

export type WebhookResult = { status: 200 | 401 | 500; outcome: 'PROCESSED' | 'DUPLICATE' | 'REJECTED' | 'FAILED' };

/** Lee el cuerpo por trozos y corta al superar el límite, aunque no declare su tamaño. Devuelve `null` si es demasiado grande. */
export async function readBodyWithLimit(request: Request, maxBytes: number = MAX_WEBHOOK_BODY_BYTES): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * Las firmas inválidas se cuentan: una fila por hora y motivo. Ni el cuerpo ni un identificador sacado de él, porque no están verificados
 * y alguien podría reservar el de un pago real; y el número de filas no crece aunque un atacante envíe millones de cuerpos distintos.
 */
async function recordRejection(db: Db, providerName: string, reason: string, now: Date): Promise<void> {
  const externalEventId = `rejected:${now.toISOString().slice(0, 13)}:${reason}`;
  const key = { provider: providerName, externalEventId };
  await db.webhookEvent.createMany({ data: [{ ...key, signatureValid: false, payloadJson: { reason }, status: 'REJECTED', processedAt: now }], skipDuplicates: true });
  await db.webhookEvent.updateMany({ where: key, data: { attempts: { increment: 1 } } });
}

/** Solo los mensajes propios, que no llevan datos de personas; de cualquier otro error, su tipo. */
const safeErrorMessage = (error: unknown): string => (error instanceof PaymentReconciliationError ? error.message.slice(0, 500) : error instanceof Error ? error.name : 'Error desconocido');

export async function handlePaymentWebhook(db: KorumPrismaClient, provider: PaymentProvider, rawBody: string, contentType: string | null, now: Date = new Date(), options: PaymentEventOptions = {}): Promise<WebhookResult> {
  const check = provider.verifyNotification(rawBody, contentType);
  if (!check.valid) {
    await recordRejection(db, provider.name, check.reason, now);
    return { status: 401, outcome: 'REJECTED' };
  }

  const { notification } = check;
  const key = { provider: provider.name, externalEventId: notification.externalEventId };
  await db.webhookEvent.createMany({ data: [{ ...key, signatureValid: true, payloadJson: notification.payload, status: 'RECEIVED' }], skipDuplicates: true });

  try {
    const processed = await db.$transaction(async (tx) => {
      // Si otra entrega va por delante, esto espera a que confirme y entonces ya no encuentra la fila pendiente.
      const claim = await tx.webhookEvent.updateMany({ where: { ...key, status: { in: ['RECEIVED', 'FAILED'] } }, data: { status: 'PROCESSED', processedAt: now, errorMessage: null, attempts: { increment: 1 } } });
      if (claim.count === 0) return false;
      await applyPaymentNotification(tx, notification, now, { ...options, cardProvider: provider.name });
      return true;
    }, QUEUED_TRANSACTION);
    return { status: 200, outcome: processed ? 'PROCESSED' : 'DUPLICATE' };
  } catch (error) {
    const message = safeErrorMessage(error);
    console.error('Fallo al procesar una notificación de pago', JSON.stringify(notification.externalEventId), message);
    await db.webhookEvent.updateMany({ where: { ...key, status: { in: ['RECEIVED', 'FAILED'] } }, data: { status: 'FAILED', errorMessage: message, attempts: { increment: 1 } } });
    return { status: 500, outcome: 'FAILED' };
  }
}
