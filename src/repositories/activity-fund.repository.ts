import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { KorumPrismaClient } from '@/lib/prisma';
import { fundBalancesOf } from '@/services/sponsors/activity-fund.service';
import { authorizeTenant, type SessionActor } from './tenant-guard';

/**
 * Lecturas del Fondo de actividades de una entidad (Sprint 4.2f). Autoriza primero (`DIRECTOR` o `COSIGNER` de **esa** entidad; el Super-Admin entra con
 * registro y en solo lectura) y elige cada campo: del comercio, su nombre y su nivel (la entidad ya los ve en Aprobaciones), nunca su contacto ni su CIF.
 * Los saldos salen del libro (`fundBalancesOf`), no de un contador.
 */

export const FUND_HISTORY_SHOWN = 20;
const DEPOSITS_SHOWN = 50;

const PAYOUT_VIEW = {
  id: true,
  amountCents: true,
  purpose: true,
  status: true,
  cancelReason: true,
  createdAt: true,
  approvedAt: true,
  executedAt: true,
  cancelledAt: true,
  requestedBy: { select: { name: true } },
  splits: { orderBy: { id: 'asc' }, select: { sponsorId: true, amountCents: true, status: true, sponsor: { select: { name: true, categoryLevel: true } } } }
} as const;

export async function loadActivityFundRows(db: KorumPrismaClient, actor: SessionActor, organizationId: string) {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'activity_fund.read', targetType: 'Organization' });
  const [organization, balances, deposits, pending, history] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { kybStatus: true, paycometSplitId: true } }),
    fundBalancesOf(db, organizationId),
    db.activityFundDeposit.findMany({
      where: { organizationId },
      orderBy: { id: 'desc' },
      take: DEPOSITS_SHOWN,
      select: { id: true, amountCents: true, createdAt: true, sponsor: { select: { id: true, name: true, categoryLevel: true } }, contribution: { select: { createdAt: true, initiative: { select: { title: true } } } } }
    }),
    db.activityFundPayout.findFirst({ where: { organizationId, status: 'PENDING_DOUBLE_CHECK' }, select: { ...PAYOUT_VIEW, signatures: true } }),
    db.activityFundPayout.findMany({ where: { organizationId, status: { not: 'PENDING_DOUBLE_CHECK' } }, orderBy: { id: 'desc' }, take: FUND_HISTORY_SHOWN, select: PAYOUT_VIEW })
  ]);
  return { organization, balances, deposits, pending, history };
}

/** Enlace de firma vigente de esta persona para la liquidación pendiente (para decirle que ya lo tiene en su email y hasta cuándo vale). */
export async function openFundChallengeOf(db: KorumPrismaClient, organizationId: string, payoutId: number, userId: string, now: Date) {
  return db.doubleCheckChallenge.findFirst({
    where: { organizationId, targetType: 'ACTIVITY_FUND_PAYOUT', fundPayoutId: payoutId, signerUserId: userId, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
    select: { expiresAt: true }
  });
}

/** Entidad dueña de una liquidación (para auditar un intento con la de otra entidad sin decirle nada a quien lo hace). */
export const fundPayoutOwner = async (db: KorumPrismaClient, payoutId: number): Promise<string | null> =>
  (await db.activityFundPayout.findUnique({ where: { id: payoutId }, select: { organizationId: true } }))?.organizationId ?? null;

/** Lo necesario para el justificante en PDF de una liquidación ejecutada, solo si es de esta entidad (si no, `null`, igual que si no existiera). */
export async function loadFundReceiptRows(db: KorumPrismaClient, actor: SessionActor, organizationId: string, payoutId: number) {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'activity_fund.receipt', targetType: 'ActivityFundPayout', targetId: payoutId });
  return db.activityFundPayout.findFirst({
    where: { id: payoutId, organizationId, status: 'EXECUTED' },
    select: {
      id: true,
      amountCents: true,
      purpose: true,
      createdAt: true,
      approvedAt: true,
      executedAt: true,
      organization: { select: { name: true, legalName: true } },
      splits: { orderBy: { id: 'asc' }, select: { amountCents: true, executedAt: true, sponsor: { select: { name: true, categoryLevel: true } }, contribution: { select: { createdAt: true } } } },
      signatures: { orderBy: { signedAt: 'asc' }, select: { signerRole: true, signedAt: true, signer: { select: { name: true } } } }
    }
  });
}
