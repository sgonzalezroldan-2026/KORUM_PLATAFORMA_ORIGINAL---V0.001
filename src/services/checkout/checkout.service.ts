import { acceptedGroup, checkoutInputSchema, isTrustedChallengeUrl, signCheckoutResult, signPaymentSimulator, type CheckoutInput } from '@/core/checkout/checkout-rules';
import { createDonationIntent, DonationIntentError } from '@/core/checkout/donation-intent.service';
import { provinceByCode } from '@/core/onboarding/provinces';
import { orderedGroupNames } from '@/core/public/course-challenge';
import { hashIpSubnet } from '@/core/security/device-signals';
import type { Keyring } from '@/core/security/crypto';
import { validateTaxId } from '@/core/tax/tax-id';
import { releaseTicketHoldInTx, reserveTickets, TicketReservationError } from '@/core/ticketing/ticket-reservation.service';
import { inTransaction } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { releaseUnits, reserveAttempt, reserveUnits } from '@/lib/rate-limit';
import { CHECKOUT_RULE, CHECKOUT_SEATS_RULE, seatHoldLimit } from '@/lib/rate-limit-rules';
import { absoluteUrl, localizedPath } from '@/lib/seo/marketing-routes';
import { checkoutResultPath, paymentSimulatorPath } from '@/lib/seo/portal-routes';
import { getCheckoutContext } from '@/repositories/checkout.repository';
import { ResourceNotFoundError } from '@/repositories/tenant-guard';
import { loadLockedContribution } from '@/services/payments/payment-reversals';
import { PaymentProviderError, type PaymentProvider } from '@/services/payments/payment-provider';

/**
 * Inicio del pago de una familia (checkout, Sprint 3.4). Valida lo que llega del navegador, crea la aportación `PENDING` (donación) o retiene
 * las plazas (taquilla) y pide a Paycomet su página de pago. El dinero solo se asienta cuando llega la notificación firmada del cobro: aquí no
 * se escribe en el libro mayor. Quién paga sale de la sesión si la hay (nunca del navegador) y, si no, del email de invitado.
 */

export interface CheckoutDeps {
  db: KorumPrismaClient;
  provider: PaymentProvider;
  keyring: Keyring;
  hmacSecret: string;
  now?: Date;
}

export interface CheckoutRequestContext {
  session: { userId: string; email: string } | null;
  /** IP de quien paga: Paycomet la exige y el límite de intentos la agrupa por red (solo como HMAC). */
  ip: string | null;
}

export type CheckoutInvalidField = 'form' | 'email' | 'amount' | 'quantity' | 'taxId' | 'fiscal';

export type CheckoutStart =
  | { status: 'REDIRECT'; url: string }
  | { status: 'INVALID'; field: CheckoutInvalidField }
  | { status: 'CLOSED' }
  | { status: 'SOLD_OUT'; available: number }
  | { status: 'RATE_LIMITED' }
  | { status: 'UNAVAILABLE' };

/** Deja como fallido un pago que no se pudo empezar y devuelve sus plazas: se bloquea la iniciativa, como en un aviso de pago fallido. */
async function abandonPendingCheckout(db: KorumPrismaClient, order: string): Promise<void> {
  await inTransaction(db, async (tx) => {
    const contribution = await loadLockedContribution(tx, { paycometOrder: order });
    if (!contribution) return;
    const { count } = await tx.contribution.updateMany({ where: { id: contribution.id, status: 'PENDING' }, data: { status: 'FAILED' } });
    if (count === 1 && contribution.type === 'TICKET') await releaseTicketHoldInTx(tx, contribution);
  });
}

function invalidField(raw: unknown): CheckoutInvalidField {
  const issues = checkoutInputSchema.safeParse(raw);
  if (issues.success) return 'form';
  const path = issues.error.issues[0]?.path[0];
  if (path === 'email') return 'email';
  if (path === 'amountCents' || path === 'guaranteeCents') return 'amount';
  if (path === 'quantity') return 'quantity';
  if (path === 'fiscal') return 'fiscal';
  return 'form';
}

/** Crea la aportación pendiente. Devuelve el pedido y el importe, o el motivo por el que no se puede pagar. */
async function createIntent(deps: CheckoutDeps, input: CheckoutInput, buyer: { userId: string; email: string } | { guestEmail: string }, network: string, now: Date) {
  const context = await getCheckoutContext(deps.db, input.orgSlug, input.initiativeId);
  const groupName = acceptedGroup(input.groupName, context.rewardEnabled, orderedGroupNames(context.organization.vertical, context.organization.participationGroupsJson));

  if (input.kind === 'DONATION') {
    if (context.format !== 'BUDGET') return { status: 'INVALID', field: 'form' } as const;
    if (input.fiscal) {
      if (!validateTaxId(input.fiscal.taxId).valid) return { status: 'INVALID', field: 'taxId' } as const;
      if (!provinceByCode(input.fiscal.provinceCode)) return { status: 'INVALID', field: 'fiscal' } as const;
    }
    const intent = await createDonationIntent(
      deps.db,
      { organizationId: context.organizationId, initiativeId: context.id, amountCents: input.amountCents, guaranteeCents: input.guaranteeCents, buyer, groupName, fiscal: input.fiscal, method: input.method, locale: input.locale },
      { keyring: deps.keyring, hmacSecret: deps.hmacSecret },
      now
    );
    return { status: 'CREATED', order: intent.paycometOrder, totalChargedCents: intent.totalChargedCents } as const;
  }

  if (context.format !== 'TICKETING') return { status: 'INVALID', field: 'form' } as const;
  // Plazas retenidas por red y evento: cada compra consume tantas unidades como plazas. Sin esto, una sola conexión podría dejar agotado el
  // evento encadenando reservas que nunca paga. Si la reserva no llega a hacerse (sin plazas, cerrado), las unidades se devuelven.
  const seatsKey = `${CHECKOUT_SEATS_RULE.prefix}${network}:${context.id}`;
  if (!(await reserveUnits(deps.db, seatsKey, { ...CHECKOUT_SEATS_RULE, limit: seatHoldLimit(context.ticketMax ?? 0) }, input.quantity, now))) return { status: 'RATE_LIMITED' } as const;
  try {
    const reservation = await reserveTickets(deps.db, { initiativeId: context.id, quantity: input.quantity, buyer, paymentMethod: input.method, groupName: groupName ?? undefined, locale: input.locale }, now);
    return { status: 'CREATED', order: reservation.paycometOrder, totalChargedCents: reservation.totalChargedCents } as const;
  } catch (error) {
    await releaseUnits(deps.db, seatsKey, input.quantity);
    throw error;
  }
}

export async function startCheckout(deps: CheckoutDeps, raw: unknown, context: CheckoutRequestContext): Promise<CheckoutStart> {
  const parsed = checkoutInputSchema.safeParse(raw);
  if (!parsed.success) return { status: 'INVALID', field: invalidField(raw) };
  const input = parsed.data;
  const now = deps.now ?? new Date();
  // Con sesión, el recibo va a la cuenta: el email que envíe el navegador se ignora.
  const guestEmail = context.session ? null : input.email;
  if (!context.session && !guestEmail) return { status: 'INVALID', field: 'email' };
  const buyer = context.session ? { userId: context.session.userId, email: context.session.email } : { guestEmail: guestEmail ?? '' };

  const network = hashIpSubnet(deps.hmacSecret, context.ip);
  if (!(await reserveAttempt(deps.db, `${CHECKOUT_RULE.prefix}${network}`, CHECKOUT_RULE, now))) return { status: 'RATE_LIMITED' };

  let created;
  try {
    created = await createIntent(deps, input, buyer, network, now);
  } catch (error) {
    if (error instanceof ResourceNotFoundError) return { status: 'CLOSED' };
    if (error instanceof DonationIntentError) {
      if (error.reason === 'INVALID_AMOUNT') return { status: 'INVALID', field: 'amount' };
      if (error.reason === 'FISCAL_NOT_AVAILABLE') return { status: 'INVALID', field: 'fiscal' };
      return { status: 'CLOSED' };
    }
    if (error instanceof TicketReservationError) {
      if (error.reason === 'SOLD_OUT') return { status: 'SOLD_OUT', available: error.availableTickets };
      if (error.reason === 'INVALID_QUANTITY') return { status: 'INVALID', field: 'quantity' };
      return { status: 'CLOSED' };
    }
    throw error;
  }
  if (created.status !== 'CREATED') return created;

  const { order } = created;
  const query = (signature: string) => `?${new URLSearchParams({ pedido: order, sig: signature }).toString()}`;
  const resultUrl = `${absoluteUrl(input.locale, checkoutResultPath(input.orgSlug, input.initiativeId))}${query(signCheckoutResult(deps.hmacSecret, order))}`;

  try {
    const hosted = await deps.provider.startHostedPayment({
      order,
      amountCents: created.totalChargedCents,
      method: input.method,
      originalIp: context.ip ?? '0.0.0.0',
      locale: input.locale,
      urlOk: resultUrl,
      urlKo: resultUrl
    });
    if (deps.provider.mode === 'mock') {
      return { status: 'REDIRECT', url: `${localizedPath(input.locale, paymentSimulatorPath(input.orgSlug, input.initiativeId))}${query(signPaymentSimulator(deps.hmacSecret, order))}` };
    }
    if (hosted.challengeUrl && isTrustedChallengeUrl(hosted.challengeUrl)) return { status: 'REDIRECT', url: hosted.challengeUrl };
  } catch (error) {
    if (!(error instanceof PaymentProviderError)) throw error;
  }
  // Sin página de pago fiable no se cobra nada: la aportación queda fallida y las plazas vuelven al aforo.
  await abandonPendingCheckout(deps.db, order);
  return { status: 'UNAVAILABLE' };
}
