'use server';

import { headers } from 'next/headers';
import { after } from 'next/server';
import { z } from 'zod';
import { getEnv } from '@/config/env';
import { getKeyring } from '@/config/keyring';
import { signCheckoutResult } from '@/core/checkout/checkout-rules';
import { isLocale } from '@/i18n/routing';
import { getAuthSession } from '@/lib/auth/session';
import { reportError } from '@/lib/error-reporting';
import { getPrisma } from '@/lib/prisma';
import { localizedPath } from '@/lib/seo/marketing-routes';
import { checkoutResultPath } from '@/lib/seo/portal-routes';
import { startCheckout, type CheckoutStart } from '@/services/checkout/checkout.service';
import { settleSimulatedPayment } from '@/services/checkout/payment-simulator';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { getPaymentProvider, PaymentConfigurationError } from '@/services/payments/provider-factory';

/**
 * Acciones del checkout (Sprint 3.4). Quién paga sale de la sesión (o del email de invitado), nunca de lo que envía el navegador; la entidad y
 * la iniciativa se comprueban por su `orgSlug` público. Los importes los recalcula el servidor.
 */

async function clientIp(): Promise<string | null> {
  const requestHeaders = await headers();
  return requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() || requestHeaders.get('x-real-ip')?.trim() || null;
}

export async function startCheckoutAction(payload: unknown): Promise<CheckoutStart> {
  const db = getPrisma();
  const env = getEnv();
  let provider;
  try {
    provider = await getPaymentProvider(db);
  } catch (error) {
    // Sin credenciales de Paycomet no se puede cobrar: se dice en lenguaje llano y la consola ya lo marca como pendiente de configurar.
    if (error instanceof PaymentConfigurationError) return { status: 'UNAVAILABLE' };
    throw error;
  }
  const [session, ip] = await Promise.all([getAuthSession(), clientIp()]);
  return startCheckout({ db, provider, keyring: getKeyring(), hmacSecret: env.DATA_HMAC_SECRET }, payload, { session: session ? { userId: session.userId, email: session.email } : null, ip });
}

const simulatorInput = z.object({
  orgSlug: z.string().min(1).max(80),
  initiativeId: z.number().int().positive(),
  locale: z.string(),
  order: z.string().max(40),
  signature: z.string().max(80),
  approve: z.boolean()
});

/** Confirma o rechaza un pago del simulador. Solo existe con `PAYCOMET_MODE=mock`: con cobros reales responde `null` sin hacer nada. */
export async function settleSimulatedPaymentAction(raw: unknown): Promise<{ url: string } | null> {
  const parsed = simulatorInput.safeParse(raw);
  if (!parsed.success || !isLocale(parsed.data.locale)) return null;
  const input = parsed.data;
  const locale = parsed.data.locale;
  const env = getEnv();
  if (env.PAYCOMET_MODE !== 'mock') return null;
  const db = getPrisma();
  const provider = await getPaymentProvider(db);
  if (!(provider instanceof MockPaycometProvider)) return null;

  const outcome = await settleSimulatedPayment(db, provider, input, { hmacSecret: env.DATA_HMAC_SECRET, qrSecret: env.QR_HMAC_SECRET });
  if (outcome === 'INVALID') return null;
  if (outcome === 'SETTLED') {
    // Como el webhook real: el recibo y las entradas salen en el propio flujo del cobro, cuando ya se ha respondido.
    after(async () => {
      try {
        await dispatchOutbox(db, buildOutboxDeps(db), { limit: 25, deadline: Date.now() + 40_000 });
      } catch (error) {
        reportError(error, { stage: 'outbox-after-simulated-payment' });
      }
    });
  }
  const query = new URLSearchParams({ pedido: input.order, sig: signCheckoutResult(env.DATA_HMAC_SECRET, input.order) });
  return { url: `${localizedPath(locale, checkoutResultPath(input.orgSlug, input.initiativeId))}?${query.toString()}` };
}
