import type { z } from 'zod';
import { postJournal } from '@/core/finance/ledger.service';
import { notifySigners } from '@/core/jobs/notify';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { revokeOpenChallenges } from '@/core/security/double-check-email';
import { requestSignature, type SignatureReceipt } from '@/core/security/double-check.service';
import { ActivityFundError, fundPayoutIdSchema, planFundPayout, requestFundPayoutSchema, splitDeadline, type FundBalance } from '@/core/sponsors/activity-fund-rules';
import { inTransaction, type Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { ACTIVITY_FUND_RULE } from '@/lib/rate-limit-rules';
import { authorizeTenant, recordAudit, recordCrossTenantAttempt, recordMissingResourceProbe, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { lockInitiatives, poolBalanceOf } from './sponsor-money';

/**
 * Fondo de actividades de la entidad (Sprint 4.2f, decisión del promotor del 2026-11-10): adónde va el dinero de un comercio **admitido** cuando su
 * bolsa vence sin campaña. No se devuelve al comercio; la entidad lo usa para sus actividades y lo liquida a su cuenta con doble firma.
 *
 * - `moveToActivityFund`: de la bolsa (`SPONSOR_CREDIT_POOL`) al Fondo (`ORG_ACTIVITY_FUND`, por comercio), con su asiento `ACTIVITY_FUND_DEPOSIT`, su
 *   entrada (`ActivityFundDeposit`) y los avisos al comercio y a quienes firman, todo en la transacción de quien llama.
 * - `requestFundPayout`: una persona firmante pide la liquidación con el destino del dinero (el justificante de uso). Se fijan sus repartos, uno por
 *   comercio, y se le envía su enlace de firma. Una sola esperando la doble firma por entidad.
 * - `cancelFundPayout`: cualquiera de las dos la retira mientras espera la doble firma; sus enlaces dejan de valer.
 */

/** Lo que tiene cada comercio en el Fondo de la entidad, leído solo del libro, con su cobro (para repartir desde él). */
export async function fundBalancesOf(db: Db, organizationId: string): Promise<FundBalance[]> {
  const rows = await db.escrowLedgerEntry.groupBy({ by: ['sponsorId', 'direction'], where: { account: 'ORG_ACTIVITY_FUND', organizationId, sponsorId: { not: null } }, _sum: { amountCents: true } });
  const bySponsor = new Map<number, number>();
  for (const row of rows) {
    if (row.sponsorId === null) continue;
    const cents = row._sum.amountCents ?? 0;
    bySponsor.set(row.sponsorId, (bySponsor.get(row.sponsorId) ?? 0) + (row.direction === 'CREDIT' ? cents : -cents));
  }
  const ids = [...bySponsor].filter(([, cents]) => cents !== 0).map(([id]) => id);
  if (ids.length === 0) return [];
  const sponsors = await db.sponsor.findMany({ where: { id: { in: ids }, organizationId }, select: { id: true, contribution: { select: { id: true, createdAt: true, status: true, paycometOrder: true, paycometAuthCode: true } } } });
  return sponsors.flatMap((sponsor) =>
    sponsor.contribution
      ? [
          {
            sponsorId: sponsor.id,
            contributionId: sponsor.contribution.id,
            chargedAt: sponsor.contribution.createdAt,
            balanceCents: bySponsor.get(sponsor.id) ?? 0,
            splittable: sponsor.contribution.status === 'COMPLETED' && sponsor.contribution.paycometOrder !== null && sponsor.contribution.paycometAuthCode !== null
          }
        ]
      : []
  );
}

/**
 * Pasa al Fondo lo que queda en la bolsa vencida de un comercio. Bloquea antes la campaña de su cobro (la misma fila que bloquean los contracargos), así
 * que un contracargo simultáneo ve el dinero en un sitio o en el otro, nunca en los dos. Repetirla no mueve nada: la bolsa ya está vacía.
 */
export async function moveToActivityFund(tx: Db, sponsorId: number, now: Date): Promise<{ movedCents: number }> {
  const reference = await tx.sponsor.findUnique({ where: { id: sponsorId }, select: { contribution: { select: { initiativeId: true } } } });
  if (!reference?.contribution) return { movedCents: 0 };
  await lockInitiatives(tx, reference.contribution.initiativeId, [], now);
  const sponsor = await tx.sponsor.findUniqueOrThrow({
    where: { id: sponsorId },
    select: { id: true, organizationId: true, name: true, email: true, status: true, organization: { select: { contentLocale: true } }, contribution: { select: { id: true, status: true, createdAt: true, locale: true, paycometOrder: true } } }
  });
  if (sponsor.status !== 'CREDIT_POOL' || sponsor.contribution?.status !== 'COMPLETED') return { movedCents: 0 };
  const movedCents = await poolBalanceOf(tx, sponsor.organizationId, sponsor.id);
  // Lo que espera ya no está en la bolsa: el comercio sigue admitido (y visible hasta que caduque su distintivo), sin plazo de bolsa.
  await tx.sponsor.update({ where: { id: sponsor.id }, data: { status: 'APPROVED', creditPoolAt: null } });
  if (movedCents <= 0) return { movedCents: 0 };

  const deposit = await tx.activityFundDeposit.create({ data: { organizationId: sponsor.organizationId, sponsorId: sponsor.id, contributionId: sponsor.contribution.id, amountCents: movedCents, createdAt: now }, select: { id: true } });
  await postJournal(tx, {
    idempotencyKey: `fund:deposit:${deposit.id}`,
    kind: 'ACTIVITY_FUND_DEPOSIT',
    description: `Bolsa vencida del comercio ${sponsor.id} al Fondo de actividades de la entidad`,
    organizationId: sponsor.organizationId,
    contributionId: sponsor.contribution.id,
    paycometReference: sponsor.contribution.paycometOrder,
    occurredAt: now,
    createdById: 'system',
    lines: [
      { account: 'SPONSOR_CREDIT_POOL', direction: 'DEBIT', amountCents: movedCents, organizationId: sponsor.organizationId, sponsorId: sponsor.id },
      { account: 'ORG_ACTIVITY_FUND', direction: 'CREDIT', amountCents: movedCents, organizationId: sponsor.organizationId, sponsorId: sponsor.id }
    ]
  });
  const deadline = splitDeadline(sponsor.contribution.createdAt).toISOString();
  await tx.outboxMessage.createMany({
    data: [
      {
        idempotencyKey: `sponsor.toEntityFund:${deposit.id}`,
        templateKey: 'sponsor.toEntityFund',
        locale: sponsor.contribution.locale ?? sponsor.organization.contentLocale,
        toAddress: sponsor.email,
        organizationId: sponsor.organizationId,
        payloadJson: { sponsorId: sponsor.id, amountCents: movedCents }
      }
    ],
    skipDuplicates: true
  });
  await notifySigners(tx, sponsor.organizationId, 'activityFund.received', `deposit:${deposit.id}`, { amountCents: movedCents, deadline });
  return { movedCents };
}

export function parseFundPayload<T extends z.ZodType>(schema: T, payload: unknown): z.infer<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new ActivityFundError('INVALID_INPUT');
  return parsed.data;
}

type Action = 'activity_fund.request' | 'activity_fund.cancel' | 'activity_fund.sign_link' | 'activity_fund.retry';

/** Solo `DIRECTOR` o `COSIGNER` de **esa** entidad, con el segundo factor en esta sesión. El Super-Admin no pide ni retira por la entidad. */
export async function authorizeFundAction(db: KorumPrismaClient, actor: SessionActor, organizationId: string, action: Action, payoutId?: number): Promise<Extract<SessionActor, { kind: 'user' }>> {
  const target = payoutId === undefined ? { targetType: 'Organization', targetId: organizationId } : { targetType: 'ActivityFundPayout', targetId: String(payoutId) };
  if (actor.kind !== 'user' || actor.secondFactor !== true) {
    await recordAudit(db, actor, { action: 'tenant.access_denied', organizationId, ...target, metadata: { reason: 'SECOND_FACTOR_REQUIRED', attempted: action } });
    throw new TenantAccessError(actor.kind === 'user' ? 'ROLE_NOT_ALLOWED' : 'ANONYMOUS');
  }
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action, targetType: target.targetType, ...(payoutId === undefined ? {} : { targetId: payoutId }), allowSuperadmin: false });
  if (payoutId !== undefined) {
    const owner = await db.activityFundPayout.findUnique({ where: { id: payoutId }, select: { organizationId: true } });
    // Igual que un recurso inexistente: no se confirma que exista en otra entidad, y queda en la auditoría.
    const probe = { organizationId, resourceType: 'ActivityFundPayout', resourceId: payoutId };
    if (!owner) {
      await recordMissingResourceProbe(db, actor, probe);
      throw new ActivityFundError('NOT_FOUND');
    }
    if (owner.organizationId !== organizationId) {
      await recordCrossTenantAttempt(db, actor, { ...probe, ownerOrganizationId: owner.organizationId });
      throw new ActivityFundError('NOT_FOUND');
    }
  }
  return actor;
}

/**
 * Pide la liquidación de lo que hoy se puede liquidar del Fondo, con el destino que escribe la entidad. La entidad debe tener los documentos del titular
 * verificados y su cuenta destino en Paycomet. Después envía a quien la pide su enlace de firma (si falla, lo puede volver a pedir desde el panel).
 */
export async function requestFundPayout(
  db: KorumPrismaClient,
  secret: string,
  actor: SessionActor,
  organizationId: string,
  payload: unknown,
  now: Date = new Date()
): Promise<{ payoutId: number; amountCents: number; receipt: SignatureReceipt | null }> {
  const { purpose } = parseFundPayload(requestFundPayoutSchema, payload);
  const user = await authorizeFundAction(db, actor, organizationId, 'activity_fund.request');
  // Pedir, retirar y volver a pedir estrenaría cada vez el límite de enlaces de firma (su clave lleva la liquidación): este va por entidad.
  await reserveFundAttempt(db, actor, organizationId, 'request', now);
  const payout = await inTransaction(db, async (tx) => {
    // La fila de la entidad ordena dos peticiones simultáneas: la segunda ya ve la primera esperando la doble firma.
    const organization = await tx.organization.update({ where: { id: organizationId }, data: { updatedAt: now }, select: { kybStatus: true, paycometSplitId: true, archivedAt: true } });
    if (organization.kybStatus !== 'VERIFIED' || organization.archivedAt) throw new ActivityFundError('KYB_NOT_VERIFIED');
    if (!organization.paycometSplitId) throw new ActivityFundError('DESTINATION_ACCOUNT_MISSING');
    if ((await tx.activityFundPayout.count({ where: { organizationId, status: 'PENDING_DOUBLE_CHECK' } })) > 0) throw new ActivityFundError('PAYOUT_PENDING');
    const plan = planFundPayout(await fundBalancesOf(tx, organizationId), now);
    if (plan.amountCents <= 0) throw new ActivityFundError('NOTHING_TO_PAY');
    const created = await tx.activityFundPayout.create({
      data: {
        organizationId,
        amountCents: plan.amountCents,
        purpose,
        requestedById: user.userId,
        createdAt: now,
        splits: { create: plan.splits.map((split) => ({ sponsorId: split.sponsorId, contributionId: split.contributionId, amountCents: split.amountCents, createdAt: now })) }
      },
      select: { id: true, amountCents: true }
    });
    // El destino no va a la auditoría (texto libre, y la auditoría no se borra): solo su longitud.
    await recordAudit(tx, actor, { action: 'activity_fund.payout_requested', organizationId, targetType: 'ActivityFundPayout', targetId: String(created.id), metadata: { amountCents: created.amountCents, splits: plan.splits.length, purposeLength: purpose.length } }, { required: true });
    return created;
  });
  const receipt = await requestSignature(db, secret, actor, organizationId, { targetType: 'ACTIVITY_FUND_PAYOUT', fundPayoutId: payout.id }, now);
  return { payoutId: payout.id, amountCents: payout.amountCents, receipt };
}

/** Límite de peticiones del Fondo por entidad; al pasarlo queda en la auditoría y se responde `RATE_LIMITED`. */
export async function reserveFundAttempt(db: KorumPrismaClient, actor: SessionActor, organizationId: string, kind: 'request' | 'retry', now: Date): Promise<void> {
  if (await reserveAttempt(db, `${ACTIVITY_FUND_RULE.prefix}${kind}:${organizationId}`, ACTIVITY_FUND_RULE, now)) return;
  await recordAudit(db, actor, { action: 'activity_fund.rate_limited', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { kind, limit: ACTIVITY_FUND_RULE.limit } });
  throw new ActivityFundError('RATE_LIMITED');
}

/** Vuelve a pedir el enlace de firma de una liquidación del Fondo que espera la doble firma (el anterior deja de valer). */
export async function requestFundSignature(db: KorumPrismaClient, secret: string, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<SignatureReceipt> {
  const { payoutId } = parseFundPayload(fundPayoutIdSchema, payload);
  await authorizeFundAction(db, actor, organizationId, 'activity_fund.sign_link', payoutId);
  return requestSignature(db, secret, actor, organizationId, { targetType: 'ACTIVITY_FUND_PAYOUT', fundPayoutId: payoutId }, now);
}

/** Anula una liquidación que espera la doble firma (en la transacción de quien llama): sus enlaces dejan de valer y su dinero vuelve a estar disponible. */
export async function cancelPendingFundPayout(tx: Db, payoutId: number, reason: 'WITHDRAWN' | 'FUND_CHANGED' | 'WINDOW_EXPIRED', now: Date): Promise<boolean> {
  const { count } = await tx.activityFundPayout.updateMany({ where: { id: payoutId, status: 'PENDING_DOUBLE_CHECK' }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: reason } });
  if (count === 0) return false;
  await revokeOpenChallenges(tx, { targetType: 'ACTIVITY_FUND_PAYOUT', fundPayoutId: payoutId }, now);
  return true;
}

/** Cualquiera de las dos personas firmantes retira la liquidación mientras espera la doble firma (por ejemplo, para cambiar el destino). */
export async function cancelFundPayout(db: KorumPrismaClient, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<void> {
  const { payoutId } = parseFundPayload(fundPayoutIdSchema, payload);
  await authorizeFundAction(db, actor, organizationId, 'activity_fund.cancel', payoutId);
  await inTransaction(db, async (tx) => {
    if (!(await cancelPendingFundPayout(tx, payoutId, 'WITHDRAWN', now))) throw new ActivityFundError('WRONG_STATUS');
    await recordAudit(tx, actor, { action: 'activity_fund.payout_cancelled', organizationId, targetType: 'ActivityFundPayout', targetId: String(payoutId), metadata: { reason: 'WITHDRAWN' } }, { required: true });
  });
}
