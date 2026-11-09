import type { JournalLine, PostJournalInput } from '@/core/finance/ledger-accounts';
import type { Keyring } from '@/core/security/crypto';
import { signPass } from '@/core/ticketing/qr-signature';
import type { Prisma } from '@/generated/prisma/client';
import type { LedgerJournalKind } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import type { InitiativeFundingPlan, PlannedMatching, PlannedPayment, PlannedPoolPayin } from './funding-plan';
import { postJournalsBulk } from './ledger-bulk';
import { uuidFromKey } from './random';
import { SEED_ACTOR } from './seed-base';
import type { KorumSeedData } from './seed-types';

/**
 * Cobros de la semilla: una `Contribution` por pago (con su pase QR en la taquilla) y los asientos de cada movimiento de
 * dinero, siempre con claves de idempotencia `seed:*`, así que volver a ejecutar la semilla no duplica nada.
 * IVA: el fee de los patrocinios lleva IVA (Regla 02 §5, tipo SEED_VAT_BPS, provisional hasta la asesoría fiscal) y se asienta en
 * TAX_PAYABLE_VAT. La comisión por tramos de las entidades no lleva IVA asentado: su factura es un documento informativo.
 */

export interface SeedSecrets {
  /** Para los hashes de firma de la doble firma (`DATA_HMAC_SECRET`). */
  hmacSecret: string;
  /** Para firmar los pases QR (`QR_HMAC_SECRET`). */
  qrSecret: string;
  /** Para cifrar los NIF de comercios y facturas (`ENCRYPTION_KEY`). */
  keyring: Keyring;
}

const CHUNK_SIZE = 500;
const PAYIN_KIND: Record<PlannedPayment['type'], LedgerJournalKind> = { DONATION: 'PAYIN_DONATION', TICKET: 'PAYIN_TICKET', SPONSORSHIP: 'PAYIN_SPONSOR' };
const REVENUE_ACCOUNT = { TICKET: 'KORUM_REVENUE_TICKET_FEE', SPONSORSHIP: 'KORUM_REVENUE_SPONSOR_FEE' } as const;
export const contributionOrder = (key: string) => `SEED-${key}`;

interface Scope {
  organizationId: string;
  initiativeId: number;
}

function payinLines(payment: PlannedPayment, scope: Scope): JournalLine[] {
  const lines: JournalLine[] = [
    { account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: payment.totalChargedCents, organizationId: scope.organizationId },
    { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: payment.amountCents, ...scope }
  ];
  if (payment.guaranteeCents > 0) {
    lines.push({ account: 'KORUM_REVENUE_GUARANTEE', direction: 'CREDIT', amountCents: payment.guaranteeCents, organizationId: scope.organizationId });
  }
  if (payment.serviceFeeCents > 0 && payment.type !== 'DONATION') {
    lines.push({ account: REVENUE_ACCOUNT[payment.type], direction: 'CREDIT', amountCents: payment.serviceFeeCents, organizationId: scope.organizationId });
  }
  if (payment.taxCents > 0) lines.push({ account: 'TAX_PAYABLE_VAT', direction: 'CREDIT', amountCents: payment.taxCents, organizationId: scope.organizationId });
  return lines;
}

function gatewayFeeLines(feeCents: number, organizationId: string): JournalLine[] {
  return [
    { account: 'GATEWAY_FEES_EXPENSE', direction: 'DEBIT', amountCents: feeCents, organizationId },
    { account: 'PSP_CLEARING', direction: 'CREDIT', amountCents: feeCents, organizationId }
  ];
}

function contributionRow(payment: PlannedPayment, scope: Scope, locale: 'es' | 'ca' | 'en', taxDeductible: boolean): Prisma.ContributionCreateManyInput {
  return {
    organizationId: scope.organizationId,
    initiativeId: scope.initiativeId,
    guestEmail: payment.email,
    canonicalEmail: payment.email,
    locale,
    fiscalYear: payment.createdAt.getUTCFullYear(),
    type: payment.type,
    groupName: payment.groupName,
    ticketQuantity: payment.type === 'TICKET' ? payment.quantity : null,
    amountCents: payment.amountCents,
    guaranteeContributionCents: payment.guaranteeCents,
    matchedBonusCents: payment.matchedBonusCents,
    totalChargedCents: payment.totalChargedCents,
    isTaxDeductible: taxDeductible && payment.type === 'DONATION',
    paymentMethod: payment.paymentMethod,
    paycometOrder: contributionOrder(payment.key),
    paycometAuthCode: `A${payment.key.replace(/\D/g, '').slice(-6).padStart(6, '0')}`,
    status: 'COMPLETED',
    createdAt: payment.createdAt,
    // Un patrocinio lleva su comercio: sin él, un contracargo o una devolución de ese cobro no se podría deshacer (heredado del Sprint 3.5, punto 10).
    sponsorId: payment.sponsorId
  };
}

/** Cobro de la bolsa Matching 2x de un comercio: una aportación como la del checkout, con su comercio, aunque su dinero espere en la bolsa. */
function poolPayinRow(payin: PlannedPoolPayin, scope: Scope, locale: 'es' | 'ca' | 'en', email: string): Prisma.ContributionCreateManyInput {
  return {
    organizationId: scope.organizationId,
    initiativeId: scope.initiativeId,
    guestEmail: email,
    canonicalEmail: email,
    locale,
    fiscalYear: payin.paidAt.getUTCFullYear(),
    type: 'SPONSORSHIP',
    amountCents: payin.poolCents,
    totalChargedCents: payin.poolCents + payin.serviceFeeCents + payin.taxCents,
    paymentMethod: 'CARD',
    paycometOrder: contributionOrder(payin.key),
    paycometAuthCode: `A${payin.key.replace(/\D/g, '').slice(-6).padStart(6, '0')}`,
    status: 'COMPLETED',
    createdAt: payin.paidAt,
    sponsorId: payin.sponsorId
  };
}

function matchingRow(release: PlannedMatching, scope: Scope, locale: 'es' | 'ca' | 'en'): Prisma.ContributionCreateManyInput {
  return {
    organizationId: scope.organizationId,
    initiativeId: scope.initiativeId,
    locale,
    fiscalYear: release.createdAt.getUTCFullYear(),
    type: 'MATCHING_FUND',
    amountCents: release.amountCents,
    totalChargedCents: 0,
    paymentMethod: 'PLATFORM',
    paycometOrder: contributionOrder(release.key),
    status: 'COMPLETED',
    createdAt: release.createdAt
  };
}

type JournalInput = Omit<PostJournalInput, 'createdById'>;

/** Asientos de un cobro: el cobro en sí y la comisión de Paycomet que lo acompaña. */
function paymentJournals(payment: PlannedPayment, scope: Scope, contributionId: number): JournalInput[] {
  const reference = contributionOrder(payment.key);
  const common = { organizationId: scope.organizationId, initiativeId: scope.initiativeId, contributionId, paycometReference: reference, occurredAt: payment.createdAt };
  return [
    { ...common, idempotencyKey: `seed:${payment.key}:payin`, kind: PAYIN_KIND[payment.type], description: `Cobro ${reference}`, lines: payinLines(payment, scope) },
    { ...common, idempotencyKey: `seed:${payment.key}:gateway`, kind: 'GATEWAY_FEE', description: `Comisión de Paycomet de ${reference}`, lines: gatewayFeeLines(payment.gatewayFeeCents, scope.organizationId) }
  ];
}

function poolPayinJournals(payin: PlannedPoolPayin, scope: Scope, contributionId: number): JournalInput[] {
  const reference = contributionOrder(payin.key);
  const common = { organizationId: scope.organizationId, initiativeId: scope.initiativeId, contributionId, paycometReference: reference, occurredAt: payin.paidAt };
  return [
    {
      ...common,
      idempotencyKey: `seed:${payin.key}:payin`,
      kind: 'PAYIN_SPONSOR',
      description: `Bolsa Matching 2x ${reference}`,
      lines: [
        { account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: payin.poolCents + payin.serviceFeeCents + payin.taxCents, organizationId: scope.organizationId },
        { account: 'MATCHING_POOL', direction: 'CREDIT', amountCents: payin.poolCents, ...scope, sponsorId: payin.sponsorId },
        { account: 'KORUM_REVENUE_SPONSOR_FEE', direction: 'CREDIT', amountCents: payin.serviceFeeCents, organizationId: scope.organizationId },
        { account: 'TAX_PAYABLE_VAT', direction: 'CREDIT', amountCents: payin.taxCents, organizationId: scope.organizationId }
      ]
    },
    { ...common, idempotencyKey: `seed:${payin.key}:gateway`, kind: 'GATEWAY_FEE', description: `Comisión de Paycomet de ${reference}`, lines: gatewayFeeLines(payin.gatewayFeeCents, scope.organizationId) }
  ];
}

function matchingReleaseJournal(release: PlannedMatching, scope: Scope, contributionId: number): JournalInput {
  return {
    organizationId: scope.organizationId,
    initiativeId: scope.initiativeId,
    contributionId,
    occurredAt: release.createdAt,
    idempotencyKey: `seed:${release.key}`,
    kind: 'MATCHING_RELEASE',
    description: `Liberación de la bolsa Matching 2x (${release.amountCents} céntimos)`,
    lines: [
      { account: 'MATCHING_POOL', direction: 'DEBIT', amountCents: release.amountCents, ...scope, sponsorId: release.sponsorId },
      { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: release.amountCents, ...scope }
    ]
  };
}
/** Escribe cobros, pases y asientos de todas las iniciativas. `ticketCounter` numera los pases de toda la semilla. */
export async function seedFunding(
  db: KorumPrismaClient,
  seed: KorumSeedData,
  plans: InitiativeFundingPlan[],
  secrets: SeedSecrets,
  schema: string,
  log: (message: string) => void = () => undefined
): Promise<void> {
  let ticketNumber = 0;
  for (const plan of plans) {
    const initiative = seed.initiatives.find((candidate) => candidate.id === plan.initiativeId)!;
    const org = seed.schools.find((candidate) => candidate.id === plan.organizationId)!;
    const scope: Scope = { organizationId: plan.organizationId, initiativeId: plan.initiativeId };
    const taxDeductible = org.ley49;

    const poolEmail = (sponsorId: number) => (seed.sponsors.find((sponsor) => sponsor.id === sponsorId)?.email ?? '').toLowerCase();
    const rows = [
      ...plan.payments.map((payment) => contributionRow(payment, scope, org.contentLocale, taxDeductible)),
      ...plan.poolPayins.map((payin) => poolPayinRow(payin, scope, org.contentLocale, poolEmail(payin.sponsorId))),
      ...plan.matching.map((release) => matchingRow(release, scope, org.contentLocale))
    ];
    for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
      await db.contribution.createMany({ data: rows.slice(offset, offset + CHUNK_SIZE), skipDuplicates: true });
    }
    const stored = await db.contribution.findMany({ where: { initiativeId: plan.initiativeId, paycometOrder: { startsWith: 'SEED-' } }, select: { id: true, paycometOrder: true } });
    const idByOrder = new Map(stored.map((row) => [row.paycometOrder!, row.id]));
    const contributionId = (key: string) => {
      const id = idByOrder.get(contributionOrder(key));
      if (id === undefined) throw new Error(`La semilla no encontró la aportación ${contributionOrder(key)}`);
      return id;
    };

    if (initiative.format === 'TICKETING') {
      const passes: Prisma.TicketPassCreateManyInput[] = plan.payments.map((payment) => {
        ticketNumber += 1;
        const uuid = uuidFromKey(`pass:${payment.key}`);
        return {
          uuid,
          contributionId: contributionId(payment.key),
          initiativeId: plan.initiativeId,
          serialCode: `PASE-${payment.createdAt.getUTCFullYear()}-${String(ticketNumber).padStart(4, '0')}`,
          subtype: initiative.ticketSubtype ?? 'EVENT',
          holderEmail: payment.email,
          quantity: payment.quantity,
          qrHmacSignature: signPass(secrets.qrSecret, uuid),
          createdAt: payment.createdAt
        };
      });
      await db.ticketPass.createMany({ data: passes, skipDuplicates: true });
    }

    const journals: JournalInput[] = [
      ...plan.poolPayins.flatMap((payin) => poolPayinJournals(payin, scope, contributionId(payin.key))),
      ...plan.payments.flatMap((payment) => paymentJournals(payment, scope, contributionId(payment.key))),
      ...plan.matching.map((release) => matchingReleaseJournal(release, scope, contributionId(release.key)))
    ];
    await postJournalsBulk(db, schema, journals.map((input) => ({ ...input, createdById: SEED_ACTOR })));
    log(`  iniciativa ${plan.initiativeId}: ${plan.payments.length} cobros, ${plan.matching.length} liberaciones de bolsa`);
  }
}
