import { verifyPaymentSimulator } from '@/core/checkout/checkout-rules';
import type { KorumPrismaClient } from '@/lib/prisma';
import { getSimulatedPayment } from '@/repositories/checkout.repository';
import type { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import type { Keyring } from '@/core/security/crypto';
import type { InvoicingContext } from '@/services/payments/sponsorship-events';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';

/**
 * Simulador de la página de pago (solo `PAYCOMET_MODE=mock`, desarrollo, demostración y pruebas E2E). Sustituye a la página de Paycomet: la
 * persona confirma o rechaza y el simulador fabrica la **misma notificación firmada** que enviaría Paycomet y la entrega al webhook de verdad,
 * así que el asiento, el pase y los emails siguen exactamente el camino real. No hay ningún atajo que acredite dinero sin esa notificación.
 */

const pad = (value: number) => String(value).padStart(2, '0');
const bankDateTime = (date: Date) =>
  `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;

export type SimulatorOutcome = 'SETTLED' | 'NOT_PENDING' | 'INVALID';

export async function settleSimulatedPayment(
  db: KorumPrismaClient,
  provider: MockPaycometProvider,
  input: { orgSlug: string; initiativeId: number; order: string; signature: string; approve: boolean },
  secrets: { hmacSecret: string; qrSecret: string; invoicing?: InvoicingContext; keyring?: Keyring },
  now: Date = new Date()
): Promise<SimulatorOutcome> {
  if (!verifyPaymentSimulator(secrets.hmacSecret, input.order, input.signature)) return 'INVALID';
  const payment = await getSimulatedPayment(db, input.orgSlug, input.initiativeId, input.order);
  if (!payment) return 'INVALID';
  if (payment.status !== 'PENDING') return 'NOT_PENDING';

  // El primer pago de Mi Hucha guarda la tarjeta: como Paycomet, la notificación trae su token.
  const card = payment.walletSubscriptionId !== null && input.approve ? provider.savedCardFor(input.order) : undefined;
  const notification = provider.buildNotification({ kind: 'PAYMENT', order: input.order, amountCents: payment.totalChargedCents, response: input.approve ? 'OK' : 'KO', bankDateTime: bankDateTime(now), card });
  const { keyring } = secrets;
  const result = await handlePaymentWebhook(db, provider, notification.rawBody, notification.contentType, now, { qrSecret: secrets.qrSecret, invoicing: secrets.invoicing, keyring: keyring ? () => keyring : undefined });
  return result.outcome === 'PROCESSED' || result.outcome === 'DUPLICATE' ? 'SETTLED' : 'INVALID';
}
