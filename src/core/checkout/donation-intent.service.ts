import { normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import type { Keyring } from '@/core/security/crypto';
import { sealDonorTaxId } from '@/core/tax/tax-id-vault';
import type { Db } from '@/lib/db';
import { canIssueTaxCertificate, newDonationOrder, spanishFiscalYear, type CheckoutFiscal } from './checkout-rules';
import { DONATION_MAX_CENTS, DONATION_MIN_CENTS, GUARANTEE_MAX_CENTS, type CheckoutMethod } from './checkout-limits';

/**
 * Intención de donación (Sprint 3.4): la aportación `PENDING` que confirmará el webhook de Paycomet. Aquí no se mueve dinero ni se escribe en
 * el libro mayor: el asiento lo crea el cobro confirmado (`payment-events.service.ts`). La campaña tiene que estar recaudando y **dentro de su
 * plazo** (`closesAt`): la tarea que la marca como vencida corre una vez al día, así que el cobro no puede fiarse de su estado (Sprint 2.4).
 */

export type DonationIntentBlock = 'NOT_FOUND' | 'NOT_OPEN' | 'INVALID_AMOUNT' | 'FISCAL_NOT_AVAILABLE';

export class DonationIntentError extends Error {
  readonly reason: DonationIntentBlock;

  constructor(reason: DonationIntentBlock) {
    super(`No se puede iniciar la donación: ${reason}.`);
    this.name = 'DonationIntentError';
    this.reason = reason;
  }
}

export interface DonationIntentInput {
  organizationId: string;
  initiativeId: number;
  amountCents: number;
  guaranteeCents: number;
  buyer: { userId: string; email: string } | { guestEmail: string };
  groupName: string | null;
  /** Ya validado por quien llama (`validateTaxId` lo repite al cifrar). `null` si la persona no pidió el certificado. */
  fiscal: CheckoutFiscal | null;
  method: CheckoutMethod;
  locale: 'es' | 'ca' | 'en';
}

export interface DonationIntent {
  contributionId: number;
  paycometOrder: string;
  totalChargedCents: number;
}

export async function createDonationIntent(db: Db, input: DonationIntentInput, keys: { keyring: Keyring; hmacSecret: string }, now: Date = new Date()): Promise<DonationIntent> {
  const { amountCents, guaranteeCents } = input;
  if (!Number.isSafeInteger(amountCents) || amountCents < DONATION_MIN_CENTS || amountCents > DONATION_MAX_CENTS) throw new DonationIntentError('INVALID_AMOUNT');
  if (!Number.isSafeInteger(guaranteeCents) || guaranteeCents < 0 || guaranteeCents > GUARANTEE_MAX_CENTS) throw new DonationIntentError('INVALID_AMOUNT');

  const initiative = await db.initiative.findFirst({
    where: { id: input.initiativeId, organizationId: input.organizationId },
    select: { format: true, status: true, closesAt: true, organization: { select: { ley49: true, ley49VerifiedAt: true, archivedAt: true } } }
  });
  if (!initiative || initiative.organization.archivedAt) throw new DonationIntentError('NOT_FOUND');
  // Solo las campañas de presupuesto reciben donaciones: la taquilla vende entradas (`reserveTickets`).
  if (initiative.format !== 'BUDGET' || initiative.status !== 'FUNDRAISING' || initiative.closesAt <= now) throw new DonationIntentError('NOT_OPEN');

  const certificate = canIssueTaxCertificate(initiative.organization);
  if (input.fiscal && !certificate) throw new DonationIntentError('FISCAL_NOT_AVAILABLE');
  // El NIF solo se guarda cifrado (con su HMAC para el Modelo 182), nunca en claro; el nombre va en el orden de la declaración.
  const fiscal = input.fiscal
    ? { ...sealDonorTaxId(input.fiscal.taxId, keys), donorFullName: input.fiscal.fullName.toUpperCase(), donorProvinceCode: input.fiscal.provinceCode, isTaxDeductible: true }
    : {};

  const buyer = 'userId' in input.buyer
    ? { userId: input.buyer.userId, canonicalEmail: normalizeCanonicalEmail(input.buyer.email) }
    : { guestEmail: input.buyer.guestEmail, canonicalEmail: normalizeCanonicalEmail(input.buyer.guestEmail) };
  const paycometOrder = newDonationOrder();
  const totalChargedCents = amountCents + guaranteeCents;
  const contribution = await db.contribution.create({
    data: {
      organizationId: input.organizationId,
      initiativeId: input.initiativeId,
      ...buyer,
      ...fiscal,
      locale: input.locale,
      fiscalYear: spanishFiscalYear(now),
      type: 'DONATION',
      groupName: input.groupName,
      amountCents,
      guaranteeContributionCents: guaranteeCents,
      totalChargedCents,
      paymentMethod: input.method,
      paycometOrder,
      status: 'PENDING',
      createdAt: now
    },
    select: { id: true }
  });
  return { contributionId: contribution.id, paycometOrder, totalChargedCents };
}
