import { after } from 'next/server';
import { hashIpSubnet } from '@/core/security/device-signals';
import { getEnv } from '@/config/env';
import { reportError } from '@/lib/error-reporting';
import { getPrisma } from '@/lib/prisma';
import { releaseAttempt, reserveAttempt } from '@/lib/rate-limit';
import { WEBHOOK_INVALID_RULE } from '@/lib/rate-limit-rules';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { loadInvoicingContext } from '@/services/invoicing/invoicing-context';
import { dispatchOutbox } from '@/services/email/outbox-processor';
import { handlePaymentWebhook, readBodyWithLimit } from '@/services/payments/paycomet-webhook.service';
import { getPaymentProvider } from '@/services/payments/provider-factory';

/**
 * Notificaciones de Paycomet. Toda la lógica está en `handlePaymentWebhook`; aquí solo se recibe el cuerpo tal cual, sin alterarlo. Primero
 * se mide el cuerpo: uno demasiado grande no llega a consultar la base ni a descifrar credenciales. Después se reserva un intento por red de
 * origen **antes** de descifrar nada: quien inunda con firmas falsas agota su cupo (`429`) sin hacer trabajo caro. Una notificación con
 * firma válida devuelve el intento, así que Paycomet nunca gasta el cupo.
 *
 * Tras un cobro confirmado, el recibo y las entradas QR se envían **en el propio flujo del cobro** (`after`: cuando ya se ha respondido a
 * Paycomet). Con el plan gratuito de Vercel la tarea `OUTBOX_DISPATCH` corre una vez al día y quien paga no puede esperar a mañana; esa
 * tarea queda como red de seguridad para lo que falle aquí.
 */

/** Mensajes que se intentan enviar tras un cobro: los de este pago y los que esperaban. */
const IMMEDIATE_DISPATCH_LIMIT = 25;
/** Pasado este tiempo desde la respuesta no se empiezan envíos nuevos; lo que quede lo recoge la tarea programada. */
const IMMEDIATE_DISPATCH_BUDGET_MS = 40_000;
export const maxDuration = 60;
export async function POST(request: Request): Promise<Response> {
  const rawBody = await readBodyWithLimit(request);
  if (rawBody === null) return new Response(null, { status: 413 });

  const env = getEnv();
  const db = getPrisma();
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const attemptKey = `${WEBHOOK_INVALID_RULE.prefix}${hashIpSubnet(env.DATA_HMAC_SECRET, forwardedFor)}`;
  if (!(await reserveAttempt(db, attemptKey, WEBHOOK_INVALID_RULE))) return new Response(null, { status: 429 });

  const provider = await getPaymentProvider(db);
  const result = await handlePaymentWebhook(db, provider, rawBody, request.headers.get('content-type'), new Date(), { qrSecret: env.QR_HMAC_SECRET, invoicing: await loadInvoicingContext(db) });
  if (result.status !== 401) await releaseAttempt(db, attemptKey);
  if (result.outcome === 'PROCESSED') {
    after(async () => {
      try {
        await dispatchOutbox(db, buildOutboxDeps(db), { limit: IMMEDIATE_DISPATCH_LIMIT, deadline: Date.now() + IMMEDIATE_DISPATCH_BUDGET_MS });
      } catch (error) {
        // El cobro ya está asentado y los mensajes siguen en la bandeja: los recoge la tarea programada.
        reportError(error, { stage: 'outbox-after-payment' });
      }
    });
  }
  return new Response(null, { status: result.status });
}
