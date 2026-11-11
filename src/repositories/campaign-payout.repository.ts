import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { KorumPrismaClient } from '@/lib/prisma';
import { READINESS_INITIATIVE_SELECT } from '@/services/payouts/payout-readiness';
import { authorizeTenant, type SessionActor } from './tenant-guard';

/**
 * Lecturas de la pantalla de liquidaciones de una entidad (Sprint 4.4a). Autoriza primero (`DIRECTOR` o `COSIGNER` de **esa** entidad; el Super-Admin entra
 * con registro y en solo lectura) y elige cada campo: del proveedor, su nombre y los 4 últimos dígitos del IBAN, nunca el IBAN ni el CIF (van cifrados y no
 * salen de aquí). De la factura, su tipo y tamaño para enlazarla.
 */

export const PAYOUT_HISTORY_SHOWN = 20;

const INVOICE_VIEW = { select: { id: true, mimeType: true, sizeBytes: true, sha256: true, organizationId: true, purpose: true, deletedAt: true } } as const;

const PAYOUT_VIEW = {
  id: true,
  organizationId: true,
  status: true,
  destinationType: true,
  beneficiaryName: true,
  beneficiaryDigest: true,
  beneficiaryIbanLast4: true,
  beneficiaryIbanBank: true,
  requestedById: true,
  providerInvoiceFileId: true,
  providerInvoiceFile: INVOICE_VIEW,
  netPaidCents: true,
  korumFeeSettledCents: true,
  createdAt: true,
  updatedAt: true,
  approvedAt: true,
  executedAt: true
} as const;

export async function loadCampaignPayoutRows(db: KorumPrismaClient, actor: SessionActor, organizationId: string) {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'payout.read', targetType: 'Organization' });
  const [organization, ready, history] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { legalName: true, kybStatus: true, archivedAt: true, paycometSplitId: true } }),
    db.initiative.findMany({
      where: { organizationId, status: 'GOAL_REACHED' },
      orderBy: [{ firstPayinAt: 'asc' }, { id: 'asc' }],
      select: { ...READINESS_INITIATIVE_SELECT, payout: { select: { ...PAYOUT_VIEW, signatures: true } } }
    }),
    db.escrowPayout.findMany({
      where: { organizationId, status: { not: 'PENDING_DOUBLE_CHECK' } },
      orderBy: { id: 'desc' },
      take: PAYOUT_HISTORY_SHOWN,
      select: {
        ...PAYOUT_VIEW,
        initiative: { select: { id: true, title: true, walletEscrowId: true, status: true, beforeFileId: true, afterFileId: true } },
        splits: { where: { status: { not: 'CANCELLED' } }, select: { amountCents: true, status: true, errorMessage: true } }
      }
    })
  ]);
  return { organization, ready, history };
}

/** Enlace de firma vigente de esta persona para la liquidación (para decirle que ya lo tiene en su email y hasta cuándo vale). */
export async function openPayoutChallengeOf(db: KorumPrismaClient, organizationId: string, payoutId: number, userId: string, now: Date) {
  return db.doubleCheckChallenge.findFirst({
    where: { organizationId, targetType: 'ESCROW_PAYOUT', payoutId, signerUserId: userId, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
    select: { expiresAt: true }
  });
}

/** Factura de proveedor de esta entidad, para abrirla por URL firmada (la llamada ya comprobó el cargo). `null` si no es suya, igual que si no existiera. */
export async function findPayoutInvoice(db: KorumPrismaClient, organizationId: string, fileId: string) {
  const file = await db.fileAsset.findUnique({ where: { id: fileId }, select: { id: true, bucket: true, objectKey: true, organizationId: true, purpose: true, deletedAt: true } });
  if (!file || file.purpose !== 'PROVIDER_INVOICE' || file.deletedAt !== null) return { file: null, ownerOrganizationId: null };
  return { file: file.organizationId === organizationId ? file : null, ownerOrganizationId: file.organizationId };
}
