import { SUSPICIOUS_REASONS } from '@/core/ideas/idea-moderation-rules';
import type { Db } from '@/lib/db';
import type { SessionActor } from '@/repositories/tenant-guard';
import type { SignerRole } from './double-check-evaluation';
import { hashChallengeToken, MAX_OTP_ATTEMPTS } from './double-check.service';

/**
 * Qué se va a firmar con un enlace de doble firma, para enseñarlo **antes** de pedir el código (página `/panel/{slug}/firmar`). Solo lo ve la
 * persona a la que se envió el enlace, con su sesión, y solo si el enlace sigue sirviendo; no gasta intentos ni deja el enlace usado. Cualquier
 * otro caso responde igual (`INVALID_LINK`), sin decir si el enlace existe: el token no debe servir para averiguar nada.
 */

export type ChallengePreview =
  | {
      status: 'READY';
      targetType: 'IDEA_APPROVAL';
      signerRole: SignerRole;
      expiresAt: Date;
      idea: { alias: string; title: string; category: string; description: string; verifiedVotes: number; revalidatedVotes: number };
    }
  | {
      status: 'READY';
      targetType: 'ESCROW_PAYOUT';
      signerRole: SignerRole;
      expiresAt: Date;
      /** Liquidación de campaña (Sprint 4.4a): a quién va, los 4 últimos dígitos del IBAN del proveedor (nunca entero) y la factura que se firma. */
      payout: {
        initiativeTitle: string;
        walletEscrowId: string;
        netPaidCents: number;
        destinationType: 'ORGANIZATION' | 'PROVIDER';
        beneficiaryName: string;
        ibanBank: string | null;
        ibanLast4: string | null;
        invoiceFileId: string | null;
        /** Quién la pidió o la cambió por última vez y cuándo: un cambio de destino no pasa desapercibido (auditoría de seguridad del 4.4a, I1). */
        requestedBy: { name: string; at: Date } | null;
      };
    }
  | {
      status: 'READY';
      targetType: 'ACTIVITY_FUND_PAYOUT';
      signerRole: SignerRole;
      expiresAt: Date;
      /** Liquidación del Fondo de actividades (Sprint 4.2f): importe, para qué es y de cuántos comercios sale (sin sus datos). */
      fund: { reference: string; amountCents: number; purpose: string; sponsors: number };
    }
  | { status: 'INVALID_LINK' };

const INVALID: ChallengePreview = { status: 'INVALID_LINK' };

export async function previewChallenge(db: Db, secret: string, actor: SessionActor, input: { token: string; organizationSlug: string }, now: Date = new Date()): Promise<ChallengePreview> {
  if (actor.kind !== 'user' || actor.isSuperadmin || actor.secondFactor !== true) return INVALID;
  const challenge = await db.doubleCheckChallenge.findUnique({
    where: { tokenHash: hashChallengeToken(secret, input.token) },
    select: { signerUserId: true, signerRole: true, targetType: true, ideaId: true, payoutId: true, fundPayoutId: true, expiresAt: true, consumedAt: true, revokedAt: true, attempts: true, organization: { select: { slug: true } } }
  });
  const usable = challenge && challenge.signerUserId === actor.userId && challenge.organization.slug === input.organizationSlug && !challenge.consumedAt && !challenge.revokedAt && challenge.expiresAt > now && challenge.attempts < MAX_OTP_ATTEMPTS;
  if (!usable) return INVALID;
  const signerRole = challenge.signerRole as SignerRole;

  if (challenge.targetType === 'IDEA_APPROVAL' && challenge.ideaId !== null) {
    const idea = await db.idea.findUnique({ where: { id: challenge.ideaId }, select: { alias: true, title: true, category: true, description: true, verifiedVotes: true } });
    if (!idea) return INVALID;
    // Cuántas firmas cuentan porque la entidad las validó a mano: quien firma lo ve antes de dar su firma.
    const revalidatedVotes = await db.ideaSignatureAudit.count({ where: { ideaId: challenge.ideaId, status: 'VERIFIED', reason: { in: [...SUSPICIOUS_REASONS] } } });
    return { status: 'READY', targetType: 'IDEA_APPROVAL', signerRole, expiresAt: challenge.expiresAt, idea: { ...idea, revalidatedVotes } };
  }
  if (challenge.targetType === 'ACTIVITY_FUND_PAYOUT' && challenge.fundPayoutId !== null) {
    const fund = await db.activityFundPayout.findUnique({ where: { id: challenge.fundPayoutId }, select: { amountCents: true, purpose: true, _count: { select: { splits: true } } } });
    if (!fund) return INVALID;
    return { status: 'READY', targetType: 'ACTIVITY_FUND_PAYOUT', signerRole, expiresAt: challenge.expiresAt, fund: { reference: `FA-${challenge.fundPayoutId}`, amountCents: fund.amountCents, purpose: fund.purpose, sponsors: fund._count.splits } };
  }
  if (challenge.payoutId === null) return INVALID;
  const payout = await db.escrowPayout.findUnique({
    where: { id: challenge.payoutId },
    select: {
      netPaidCents: true,
      destinationType: true,
      beneficiaryName: true,
      beneficiaryIbanBank: true,
      beneficiaryIbanLast4: true,
      providerInvoiceFileId: true,
      requestedById: true,
      createdAt: true,
      updatedAt: true,
      initiative: { select: { title: true, walletEscrowId: true } }
    }
  });
  if (!payout) return INVALID;
  const requester = payout.requestedById ? await db.user.findUnique({ where: { id: payout.requestedById }, select: { name: true } }) : null;
  return {
    status: 'READY',
    targetType: 'ESCROW_PAYOUT',
    signerRole,
    expiresAt: challenge.expiresAt,
    payout: {
      initiativeTitle: payout.initiative.title,
      walletEscrowId: payout.initiative.walletEscrowId,
      netPaidCents: payout.netPaidCents,
      destinationType: payout.destinationType,
      beneficiaryName: payout.beneficiaryName,
      ibanBank: payout.beneficiaryIbanBank,
      ibanLast4: payout.beneficiaryIbanLast4,
      invoiceFileId: payout.providerInvoiceFileId,
      requestedBy: requester ? { name: requester.name, at: payout.updatedAt ?? payout.createdAt } : null
    }
  };
}
