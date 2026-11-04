import { hashIpSubnet } from '@/core/security/device-signals';
import { getEnv } from '@/config/env';
import { getPrisma } from '@/lib/prisma';
import { releaseAttempt, reserveAttempt } from '@/lib/rate-limit';
import { WEBHOOK_INVALID_RULE } from '@/lib/rate-limit-rules';
import { handlePaymentWebhook, readBodyWithLimit } from '@/services/payments/paycomet-webhook.service';
import { getPaymentProvider } from '@/services/payments/provider-factory';

/**
 * Notificaciones de Paycomet. Toda la lógica está en `handlePaymentWebhook`; aquí solo se recibe el cuerpo tal cual, sin alterarlo. Primero
 * se mide el cuerpo: uno demasiado grande no llega a consultar la base ni a descifrar credenciales. Después se reserva un intento por red de
 * origen **antes** de descifrar nada: quien inunda con firmas falsas agota su cupo (`429`) sin hacer trabajo caro. Una notificación con
 * firma válida devuelve el intento, así que Paycomet nunca gasta el cupo.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await readBodyWithLimit(request);
  if (rawBody === null) return new Response(null, { status: 413 });

  const env = getEnv();
  const db = getPrisma();
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const attemptKey = `${WEBHOOK_INVALID_RULE.prefix}${hashIpSubnet(env.DATA_HMAC_SECRET, forwardedFor)}`;
  if (!(await reserveAttempt(db, attemptKey, WEBHOOK_INVALID_RULE))) return new Response(null, { status: 429 });

  const provider = await getPaymentProvider(db);
  const result = await handlePaymentWebhook(db, provider, rawBody, request.headers.get('content-type'), new Date(), { qrSecret: env.QR_HMAC_SECRET });
  if (result.status !== 401) await releaseAttempt(db, attemptKey);
  return new Response(null, { status: result.status });
}
