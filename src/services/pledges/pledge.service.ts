import { canIssueTaxCertificate, spanishFiscalYear } from '@/core/checkout/checkout-rules';
import { provinceByCode } from '@/core/onboarding/provinces';
import { newPledgeOrder, nextChargeAt, pickPledgeCampaign, pledgeFeeCents, pledgeInputSchema, type PledgeInput } from '@/core/pledges/pledge-rules';
import { deleteCardsOf } from '@/core/privacy/erasure.service';
import type { Keyring } from '@/core/security/crypto';
import { hashIpSubnet } from '@/core/security/device-signals';
import { normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import { validateTaxId } from '@/core/tax/tax-id';
import { sealDonorTaxId } from '@/core/tax/tax-id-vault';
import { inTransaction, type Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { CHECKOUT_RULE } from '@/lib/rate-limit-rules';
import { absoluteUrl } from '@/lib/seo/marketing-routes';
import { huchaResultPath } from '@/lib/seo/portal-routes';
import { writeAudit } from '@/services/audit/audit.service';
import { startHostedRedirect } from '@/services/checkout/hosted-checkout';
import type { PaymentProvider } from '@/services/payments/payment-provider';
import { getSetting } from '@/services/settings/settings.service';

/**
 * Aportación mensual de Mi Hucha (`PLEDGE`, Sprint 3.8, skill de pagos §7). La persona sale siempre de la sesión y la entidad de su `orgSlug`
 * público; los importes los fija el servidor. Aquí no se mueve dinero: el primer mes se paga en la página de Paycomet (que guarda la tarjeta) y
 * lo asienta su notificación; los siguientes los cobra la tarea `MONTHLY_TOPUP`. Nunca hay saldo que guardar ni que retirar.
 */

export interface PledgeDeps {
  db: KorumPrismaClient;
  provider: PaymentProvider;
  keyring: Keyring;
  hmacSecret: string;
  now?: Date;
}

export type PledgeInvalidField = 'form' | 'amount' | 'months' | 'campaign' | 'taxId' | 'fiscal';

export type PledgeStart =
  | { status: 'REDIRECT'; url: string }
  | { status: 'INVALID'; field: PledgeInvalidField }
  | { status: 'NO_CAMPAIGN' }
  | { status: 'ALREADY_ACTIVE' }
  | { status: 'NOT_FOUND' }
  | { status: 'RATE_LIMITED' }
  | { status: 'DISABLED' }
  | { status: 'UNAVAILABLE' };

/** Campañas que pueden recibir una aportación mensual: recaudando, de presupuesto (no taquilla) y dentro de plazo. */
export const openPledgeCampaigns = (now: Date) => ({ status: 'FUNDRAISING', format: 'BUDGET', closesAt: { gt: now } }) as const;

/** Estados en los que la aportación sigue viva: no se puede empezar otra con la misma entidad. */
const LIVE_STATUSES = ['ACTIVE', 'PAUSED'] as const;

/** Versión de los textos legales que acepta quien da de alta la aportación (prueba del mandato de los cobros sin la persona delante). */
const FALLBACK_POLICY_VERSION = '2026-11-01';

type PledgeAuditAction = 'pledge.started' | 'pledge.paused' | 'pledge.resumed' | 'pledge.campaign_changed' | 'pledge.cancelled';

/** Rastro de cada decisión de la familia sobre su aportación: solo identificadores, importes y versiones, nunca datos personales en claro. */
async function auditPledge(db: Db, userId: string, pledgeId: number, organizationId: string | null, action: PledgeAuditAction, metadata: Record<string, unknown> = {}): Promise<void> {
  await writeAudit(db, { actorType: 'USER', actorUserId: userId, organizationId, action, targetType: 'WalletSubscription', targetId: String(pledgeId), metadata });
}

/**
 * Una aportación que no se encuentra para esta persona: si existe y es de otra, se registra el intento (Regla 01 §4). La respuesta es la misma
 * que si no existiera.
 */
async function notFoundFor(db: Db, userId: string, pledgeId: number, action: string): Promise<PledgeChange> {
  const other = await db.walletSubscription.findFirst({ where: { id: pledgeId, NOT: { userId } }, select: { organizationId: true } });
  if (other) await writeAudit(db, { actorType: 'USER', actorUserId: userId, organizationId: other.organizationId, action: 'pledge.access_denied', targetType: 'WalletSubscription', targetId: String(pledgeId), metadata: { attempted: action } });
  return { status: 'NOT_FOUND' };
}

/** Mi Hucha solo existe en `PLEDGE` mientras el monedero regulado está aplazado: en cualquier otro modo no se programa ni se cobra nada. */
export async function pledgeModeEnabled(db: Db): Promise<boolean> {
  return (await getSetting(db, 'hucha.mode')) === 'PLEDGE';
}

function invalidField(raw: unknown): PledgeInvalidField {
  const parsed = pledgeInputSchema.safeParse(raw);
  if (parsed.success) return 'form';
  const path = parsed.error.issues[0]?.path[0];
  if (path === 'amountCents') return 'amount';
  if (path === 'months') return 'months';
  if (path === 'fiscal') return 'fiscal';
  return 'form';
}

function fiscalOf(input: PledgeInput, keys: { keyring: Keyring; hmacSecret: string }) {
  if (!input.fiscal) return {};
  // El NIF solo se guarda cifrado en la donación de cada mes (con su HMAC para el Modelo 182): la aportación mensual no lo guarda.
  return { ...sealDonorTaxId(input.fiscal.taxId, keys), donorFullName: input.fiscal.fullName.toUpperCase(), donorProvinceCode: input.fiscal.provinceCode, isTaxDeductible: true };
}

export async function startPledge(deps: PledgeDeps, raw: unknown, context: { session: { userId: string; email: string }; ip: string | null }): Promise<PledgeStart> {
  const { db } = deps;
  const now = deps.now ?? new Date();
  if (!(await pledgeModeEnabled(db))) return { status: 'DISABLED' };
  const parsed = pledgeInputSchema.safeParse(raw);
  if (!parsed.success) return { status: 'INVALID', field: invalidField(raw) };
  const input = parsed.data;
  const network = hashIpSubnet(deps.hmacSecret, context.ip);
  if (!(await reserveAttempt(db, `${CHECKOUT_RULE.prefix}${network}`, CHECKOUT_RULE, now))) return { status: 'RATE_LIMITED' };

  const organization = await db.organization.findFirst({
    where: { slug: input.orgSlug, archivedAt: null },
    select: { id: true, ley49: true, ley49VerifiedAt: true, initiatives: { where: openPledgeCampaigns(now), select: { id: true, closesAt: true } } }
  });
  if (!organization) return { status: 'NOT_FOUND' };
  if (input.initiativeId !== null && !organization.initiatives.some((campaign) => campaign.id === input.initiativeId)) return { status: 'INVALID', field: 'campaign' };
  const campaign = pickPledgeCampaign(organization.initiatives, input.initiativeId, now);
  if (!campaign) return { status: 'NO_CAMPAIGN' };
  if (input.fiscal) {
    if (!canIssueTaxCertificate(organization)) return { status: 'INVALID', field: 'fiscal' };
    if (!validateTaxId(input.fiscal.taxId).valid) return { status: 'INVALID', field: 'taxId' };
    if (!provinceByCode(input.fiscal.provinceCode)) return { status: 'INVALID', field: 'fiscal' };
  }
  const live = await db.walletSubscription.findFirst({ where: { userId: context.session.userId, organizationId: organization.id, status: { in: [...LIVE_STATUSES] } }, select: { id: true } });
  if (live) return { status: 'ALREADY_ACTIVE' };

  const rules = await db.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' }, select: { topupFeeCents: true, topupFeeBps: true } });
  const feeCents = pledgeFeeCents(input.amountCents, rules);
  const order = newPledgeOrder();
  const fiscal = fiscalOf(input, deps);
  const termsVersion = (await getSetting(db, 'privacy.policyVersion')) ?? FALLBACK_POLICY_VERSION;

  const subscriptionId = await inTransaction(db, async (tx) => {
    // Un alta anterior con esta entidad que nunca se pagó queda sustituida por esta: si aún se pagara, ese mes cuenta como donación y nada más.
    await tx.walletSubscription.updateMany({ where: { userId: context.session.userId, organizationId: organization.id, status: 'PENDING' }, data: { status: 'CANCELLED', statusReason: 'REPLACED', statusChangedAt: now } });
    const subscription = await tx.walletSubscription.create({
      data: {
        userId: context.session.userId,
        organizationId: organization.id,
        initiativeId: input.initiativeId,
        monthlyAmountCents: input.amountCents,
        feePerMonthCents: feeCents,
        totalMonths: input.months,
        status: 'PENDING',
        termsVersion,
        nextChargeAt: now,
        createdAt: now
      },
      select: { id: true }
    });
    await tx.contribution.create({
      data: {
        organizationId: organization.id,
        initiativeId: campaign.id,
        userId: context.session.userId,
        canonicalEmail: normalizeCanonicalEmail(context.session.email),
        ...fiscal,
        locale: input.locale,
        fiscalYear: spanishFiscalYear(now),
        type: 'DONATION',
        amountCents: input.amountCents,
        totalChargedCents: input.amountCents + feeCents,
        paymentMethod: 'CARD',
        paycometOrder: order,
        status: 'PENDING',
        walletSubscriptionId: subscription.id,
        pledgeCycle: 1,
        createdAt: now
      }
    });
    // Programar una aportación es actividad de la cuenta (como aportar, heredado del 3.2).
    await tx.user.updateMany({ where: { id: context.session.userId, gdprAnonymizedAt: null }, data: { lastActiveAt: now } });
    return subscription.id;
  });
  await auditPledge(db, context.session.userId, subscriptionId, organization.id, 'pledge.started', { amountCents: input.amountCents, feeCents, months: input.months, initiativeId: input.initiativeId, termsVersion, certificate: input.fiscal !== null });

  const url = await startHostedRedirect(deps.provider, deps.hmacSecret, {
    order,
    totalChargedCents: input.amountCents + feeCents,
    method: 'CARD',
    orgSlug: input.orgSlug,
    initiativeId: campaign.id,
    locale: input.locale,
    ip: context.ip,
    returnUrl: absoluteUrl(input.locale, huchaResultPath(order)),
    saveCard: true
  });
  if (url) return { status: 'REDIRECT', url };
  // Sin página de pago fiable no se cobra nada: la aportación no llega a empezar.
  await inTransaction(db, async (tx) => {
    const contribution = await tx.contribution.findUniqueOrThrow({ where: { paycometOrder: order }, select: { walletSubscriptionId: true } });
    await tx.contribution.updateMany({ where: { paycometOrder: order, status: 'PENDING' }, data: { status: 'FAILED' } });
    if (contribution.walletSubscriptionId) {
      await tx.walletSubscription.updateMany({ where: { id: contribution.walletSubscriptionId, status: 'PENDING' }, data: { status: 'CANCELLED', statusReason: 'FIRST_PAYMENT_FAILED', statusChangedAt: now } });
    }
  });
  return { status: 'UNAVAILABLE' };
}

export type PledgeChange = { status: 'DONE' } | { status: 'NOT_FOUND' } | { status: 'CARD_UNAVAILABLE' } | { status: 'INVALID' };

/** Pausar: no se cobra nada hasta que la familia la reanude. Los meses no corren mientras tanto. */
export async function pausePledge(db: Db, userId: string, pledgeId: number, now: Date = new Date()): Promise<PledgeChange> {
  const { count } = await db.walletSubscription.updateMany({ where: { id: pledgeId, userId, status: 'ACTIVE' }, data: { status: 'PAUSED', statusReason: 'BY_FAMILY', statusChangedAt: now } });
  if (count === 0) return notFoundFor(db, userId, pledgeId, 'pause');
  await auditPledge(db, userId, pledgeId, await organizationOf(db, pledgeId), 'pledge.paused');
  return { status: 'DONE' };
}

async function organizationOf(db: Db, pledgeId: number): Promise<string | null> {
  return (await db.walletSubscription.findUnique({ where: { id: pledgeId }, select: { organizationId: true } }))?.organizationId ?? null;
}

/** Reanudar: el siguiente cobro es el próximo día de cobro a partir de hoy, nunca los meses atrasados. Hace falta que la tarjeta siga guardada. */
export async function resumePledge(db: Db, userId: string, pledgeId: number, now: Date = new Date()): Promise<PledgeChange> {
  const pledge = await db.walletSubscription.findFirst({
    where: { id: pledgeId, userId, status: 'PAUSED' },
    select: { chargeDay: true, executedMonths: true, totalMonths: true, organizationId: true, paymentMethodToken: { select: { revokedAt: true } } }
  });
  if (!pledge || pledge.executedMonths >= pledge.totalMonths) return pledge ? { status: 'NOT_FOUND' } : notFoundFor(db, userId, pledgeId, 'resume');
  if (!pledge.paymentMethodToken || pledge.paymentMethodToken.revokedAt) return { status: 'CARD_UNAVAILABLE' };
  const { count } = await db.walletSubscription.updateMany({
    where: { id: pledgeId, userId, status: 'PAUSED' },
    data: { status: 'ACTIVE', statusReason: null, statusChangedAt: now, nextChargeAt: nextChargeAt(now, pledge.chargeDay) }
  });
  if (count === 0) return { status: 'NOT_FOUND' };
  await auditPledge(db, userId, pledgeId, pledge.organizationId, 'pledge.resumed');
  return { status: 'DONE' };
}

/** Cambiar la campaña preferida (o volver a «la que antes cierre»). Solo una que esté recaudando en la misma entidad. */
export async function changePledgeCampaign(db: Db, userId: string, pledgeId: number, initiativeId: number | null, now: Date = new Date()): Promise<PledgeChange> {
  const pledge = await db.walletSubscription.findFirst({ where: { id: pledgeId, userId, status: { in: [...LIVE_STATUSES] } }, select: { organizationId: true } });
  if (!pledge?.organizationId) return pledge ? { status: 'NOT_FOUND' } : notFoundFor(db, userId, pledgeId, 'campaign');
  if (initiativeId !== null) {
    const campaign = await db.initiative.findFirst({ where: { id: initiativeId, organizationId: pledge.organizationId, ...openPledgeCampaigns(now) }, select: { id: true } });
    if (!campaign) return { status: 'INVALID' };
  }
  const { count } = await db.walletSubscription.updateMany({ where: { id: pledgeId, userId, status: { in: [...LIVE_STATUSES] } }, data: { initiativeId } });
  if (count === 0) return { status: 'NOT_FOUND' };
  await auditPledge(db, userId, pledgeId, pledge.organizationId, 'pledge.campaign_changed', { initiativeId });
  return { status: 'DONE' };
}

/**
 * Cancelar: no se vuelve a cobrar y la tarjeta se borra en Paycomet (solo se guardó para esta aportación). Si Paycomet no confirma el borrado,
 * la tarjeta queda revocada (ya no se puede cobrar con ella) y la purga semanal lo reintenta, con su alerta.
 */
export async function cancelPledge(deps: { db: Db; paymentProvider: () => Promise<PaymentProvider>; keyring: Keyring }, userId: string, pledgeId: number, now: Date = new Date()): Promise<PledgeChange> {
  const pledge = await deps.db.walletSubscription.findFirst({ where: { id: pledgeId, userId, status: { in: [...LIVE_STATUSES] } }, select: { paymentMethodTokenId: true, organizationId: true } });
  if (!pledge) return notFoundFor(deps.db, userId, pledgeId, 'cancel');
  const { count } = await deps.db.walletSubscription.updateMany({ where: { id: pledgeId, userId, status: { in: [...LIVE_STATUSES] } }, data: { status: 'CANCELLED', statusReason: 'BY_FAMILY', statusChangedAt: now } });
  if (count === 0) return { status: 'NOT_FOUND' };
  await auditPledge(deps.db, userId, pledgeId, pledge.organizationId, 'pledge.cancelled');
  if (pledge.paymentMethodTokenId !== null) await retirePledgeCard(deps, pledge.paymentMethodTokenId, now);
  return { status: 'DONE' };
}

/** Borra en Paycomet la tarjeta de una aportación que ya no cobra (cancelada o terminada). Nunca hace fallar a quien llama. */
export async function retirePledgeCard(deps: { db: Db; paymentProvider: () => Promise<PaymentProvider>; keyring: Keyring }, paymentMethodTokenId: number, now: Date): Promise<void> {
  await deps.db.paymentMethodToken.updateMany({ where: { id: paymentMethodTokenId, revokedAt: null }, data: { revokedAt: now } });
  await deleteCardsOf(deps.db, deps, { id: paymentMethodTokenId }, now);
}
