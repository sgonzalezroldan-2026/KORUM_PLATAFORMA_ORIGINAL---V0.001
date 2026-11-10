import { evaluateDoubleCheck, type SignerRole } from '@/core/security/double-check-evaluation';
import { activityFundTargetDigest } from '@/core/security/signature-hash';
import { planFundPayout } from '@/core/sponsors/activity-fund-rules';
import type { SponsorLevel } from '@/core/sponsors/sponsorship-rules';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadActivityFundRows, openFundChallengeOf } from '@/repositories/activity-fund.repository';
import { listSigners } from '@/repositories/organization.repository';
import type { SessionActor } from '@/repositories/tenant-guard';
import type { DoubleCheckSlot } from './approvals-data';

/**
 * El Fondo de actividades de la entidad (Sprint 4.2f) preparado para la vista: importes en céntimos y fechas en ISO. Las firmas de la liquidación
 * pendiente se comprueban **en el servidor** (huella, cargo vigente, personas distintas), igual que al aprobar: el panel no se fía de que exista una fila.
 */

export type FundPayoutStatus = 'PENDING_DOUBLE_CHECK' | 'APPROVED' | 'PROCESSING' | 'EXECUTED' | 'FAILED' | 'CANCELLED';

export interface FundPayoutView {
  id: number;
  reference: string;
  amountCents: number;
  purpose: string;
  status: FundPayoutStatus;
  cancelReason: 'WITHDRAWN' | 'FUND_CHANGED' | 'WINDOW_EXPIRED' | null;
  requestedBy: string;
  createdAt: string;
  executedAt: string | null;
  /** Lo ya enviado a la cuenta de la entidad (repartos hechos). */
  doneCents: number;
  splits: Array<{ sponsor: string; level: SponsorLevel; amountCents: number; done: boolean }>;
}

export interface ActivityFundView {
  /** Lo que hoy se puede liquidar (cobros dentro de su ventana de 90 días), sin lo que ya está en una liquidación pendiente. */
  availableCents: number;
  /** Fecha límite del primer cobro: antes de ella hay que firmar y enviar la liquidación. */
  deadline: string | null;
  /** Dinero del Fondo que ya no se puede repartir (ventana vencida): lo resuelve KORUM con Paycomet. */
  stuckCents: number;
  /** La entidad puede cobrar: documentos del titular verificados y cuenta destino en Paycomet. */
  payable: boolean;
  deposits: Array<{ id: number; sponsor: string; level: SponsorLevel; amountCents: number; createdAt: string; chargedAt: string; origin: string }>;
  pending: (FundPayoutView & { signed: number; slots: DoubleCheckSlot[]; mySlotOpen: boolean; myChallengeExpiresAt: string | null }) | null;
  history: FundPayoutView[];
}

type Rows = Awaited<ReturnType<typeof loadActivityFundRows>>;
type PayoutRow = NonNullable<Rows['pending']> | Rows['history'][number];

function payoutView(row: PayoutRow): FundPayoutView {
  return {
    id: row.id,
    reference: `FA-${row.id}`,
    amountCents: row.amountCents,
    purpose: row.purpose,
    status: row.status,
    cancelReason: row.cancelReason === 'WITHDRAWN' || row.cancelReason === 'FUND_CHANGED' || row.cancelReason === 'WINDOW_EXPIRED' ? row.cancelReason : null,
    requestedBy: row.requestedBy.name,
    createdAt: row.createdAt.toISOString(),
    executedAt: row.executedAt?.toISOString() ?? null,
    doneCents: row.splits.filter((split) => split.status === 'DONE').reduce((sum, split) => sum + split.amountCents, 0),
    splits: row.splits.map((split) => ({ sponsor: split.sponsor.name, level: split.sponsor.categoryLevel as SponsorLevel, amountCents: split.amountCents, done: split.status === 'DONE' }))
  };
}

export async function loadActivityFund(db: KorumPrismaClient, secret: string, actor: SessionActor, organizationId: string, now: Date = new Date()): Promise<ActivityFundView> {
  const rows = await loadActivityFundRows(db, actor, organizationId);
  const plan = planFundPayout(rows.balances, now);
  const pendingCents = rows.pending?.amountCents ?? 0;

  let pending: ActivityFundView['pending'] = null;
  if (rows.pending) {
    const signers = await listSigners(db, actor, organizationId);
    // La huella se calcula con los repartos tal como se fijaron, igual que al firmar.
    const context = { organizationId, targetType: 'ACTIVITY_FUND_PAYOUT' as const, targetId: rows.pending.id, targetDigest: activityFundTargetDigest(secret, { ...rows.pending, organizationId }, rows.organization.paycometSplitId) };
    const evaluation = await evaluateDoubleCheck(db, secret, context, rows.pending.signatures);
    const invalid = new Set(evaluation.invalid.map((entry) => entry.signatureId));
    const valid = rows.pending.signatures.filter((signature) => !invalid.has(signature.id) && evaluation.validRoles.includes(signature.signerRole as SignerRole));
    const slots = (['DIRECTOR', 'COSIGNER'] as const).map((role): DoubleCheckSlot => {
      const signature = valid.find((entry) => entry.signerRole === role);
      const signer = signature ? signers.find((entry) => entry.userId === signature.signerUserId && entry.role === role) : undefined;
      const holder = signers.find((entry) => entry.role === role && entry.status !== 'INVITED') ?? signers.find((entry) => entry.role === role);
      return { role, holderLabel: holder?.roleLabel?.trim() || null, signedBy: signature ? { name: signer?.name ?? '', roleLabel: signer?.roleLabel ?? null, signedAt: signature.signedAt.toISOString() } : null };
    });
    const myRoles = actor.kind === 'user' && !actor.isSuperadmin ? actor.memberships.filter((membership) => membership.organizationId === organizationId).map((membership) => membership.role) : [];
    const myRole = myRoles.length === 1 && (myRoles[0] === 'DIRECTOR' || myRoles[0] === 'COSIGNER') ? myRoles[0] : null;
    const iSigned = actor.kind === 'user' && valid.some((signature) => signature.signerUserId === actor.userId);
    const challenge = actor.kind === 'user' && myRole ? await openFundChallengeOf(db, organizationId, rows.pending.id, actor.userId, now) : null;
    pending = {
      ...payoutView(rows.pending),
      signed: valid.length,
      slots,
      mySlotOpen: myRole !== null && !iSigned && !evaluation.validRoles.includes(myRole),
      myChallengeExpiresAt: challenge ? challenge.expiresAt.toISOString() : null
    };
  }

  return {
    availableCents: Math.max(0, plan.amountCents - pendingCents),
    deadline: plan.deadline?.toISOString() ?? null,
    stuckCents: plan.stuckCents,
    payable: rows.organization.kybStatus === 'VERIFIED' && rows.organization.paycometSplitId !== null,
    deposits: rows.deposits.map((deposit) => ({
      id: deposit.id,
      sponsor: deposit.sponsor.name,
      level: deposit.sponsor.categoryLevel as SponsorLevel,
      amountCents: deposit.amountCents,
      createdAt: deposit.createdAt.toISOString(),
      chargedAt: deposit.contribution.createdAt.toISOString(),
      origin: deposit.contribution.initiative.title
    })),
    pending,
    history: rows.history.map(payoutView)
  };
}
