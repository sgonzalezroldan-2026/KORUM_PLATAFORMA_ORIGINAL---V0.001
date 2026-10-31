import { getPrisma } from '@/lib/prisma';
import { handlePaymentWebhook, readBodyWithLimit } from '@/services/payments/paycomet-webhook.service';
import { getPaymentProvider } from '@/services/payments/provider-factory';

/**
 * Notificaciones de Paycomet. Toda la lógica está en `handlePaymentWebhook`; aquí solo se recibe el cuerpo tal cual, sin alterarlo. Primero
 * se mide el cuerpo: uno demasiado grande no llega a consultar la base ni a descifrar credenciales.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await readBodyWithLimit(request);
  if (rawBody === null) return new Response(null, { status: 413 });

  const db = getPrisma();
  const provider = await getPaymentProvider(db);
  const result = await handlePaymentWebhook(db, provider, rawBody, request.headers.get('content-type'));
  return new Response(null, { status: result.status });
}
