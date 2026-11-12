import { invoiceRequired, payoutFigures, payoutFiguresMatch, payoutWindow } from '@/core/payouts/campaign-payout-rules';
import { evaluateDoubleCheck, requiredRolesFor, type SignerRole } from '@/core/security/double-check-evaluation';
import { payoutDigestFor } from '@/core/security/signature-hash';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadCampaignPayoutRows, openPayoutChallengeOf } from '@/repositories/campaign-payout.repository';
import { listSigners } from '@/repositories/organization.repository';
import type { SessionActor } from '@/repositories/tenant-guard';
import { BLOCKED_PAYOUT_SPLIT_MESSAGES } from '@/services/payments/split-transfer.service';
import { payoutBlockers, type PayoutBlocker } from '@/services/payouts/payout-readiness';
import type { DoubleCheckSlot } from './approvals-data';

/**
 * La pantalla de liquidaciones de una entidad (Sprint 4.4a) preparada para la vista: importes en céntimos y fechas en ISO. Las firmas de una liquidación
 * pendiente se comprueban **en el servidor** (huella, cargo vigente, personas distintas), igual que al aprobar: el panel no se fía de que exista una fila.
 */

export interface PendingPayoutView {
  id: number;
  reference: string;
  destinationType: 'ORGANIZATION' | 'PROVIDER';
  beneficiaryName: string;
  ibanBank: string | null;
  ibanLast4: string | null;
  /** Quién la pidió o la cambió por última vez (auditoría de seguridad del 4.4a, I1). */
  requestedBy: string | null;
  netPaidCents: number;
  invoice: { fileId: string; mimeType: string; sizeBytes: number } | null;
  /** La factura sigue siendo válida (de la entidad, de proveedor, sin borrar); si no, nadie puede firmar hasta adjuntar otra. */
  invoiceValid: boolean;
  /** Las cifras ya no cuadran con lo recaudado (un contracargo): hay que volver a pedirla, y a firmarla. */
  stale: boolean;
  updatedAt: string;
  signed: number;
  slots: DoubleCheckSlot[];
  mySlotOpen: boolean;
  myChallengeExpiresAt: string | null;
}

export interface ReadyInitiativeView {
  id: number;
  title: string;
  walletEscrowId: string;
  format: 'BUDGET' | 'TICKETING';
  raisedCents: number;
  goalCents: number;
  netPaidCents: number;
  korumFeeCents: number;
  gatewayInGoalCents: number;
  invoiceRequired: boolean;
  blockers: PayoutBlocker[];
  window: { deadline: string; daysLeft: number } | null;
  pending: PendingPayoutView | null;
}

export type HistoryStatus = 'APPROVED' | 'PROCESSING' | 'EXECUTED' | 'FAILED';

export interface PayoutHistoryView {
  id: number;
  reference: string;
  initiativeId: number;
  title: string;
  walletEscrowId: string;
  status: HistoryStatus;
  destinationType: 'ORGANIZATION' | 'PROVIDER';
  beneficiaryName: string;
  ibanBank: string | null;
  ibanLast4: string | null;
  netPaidCents: number;
  doneCents: number;
  executedAt: string | null;
  /** Un reparto bloqueado o de resultado desconocido: lo revisa KORUM con Paycomet; la entidad no tiene nada que hacer. */
  underReview: boolean;
  /** Cerrada sin las dos fotos: el siguiente paso de la entidad (EXPERIENCIA §4, `payout.executed`). */
  photosMissing: boolean;
}

export interface CampaignPayoutsView {
  ready: ReadyInitiativeView[];
  history: PayoutHistoryView[];
  /** Documentos del titular verificados y entidad activa: sin eso no se puede pedir nada. */
  payable: boolean;
  /** La entidad tiene su cuenta en Paycomet (para recibir el dinero ella). */
  organizationAccount: boolean;
  /** El proveedor de pagos sabe pagar directamente a un proveedor (hoy solo el simulador: pendiente de Paycomet). */
  providerPayoutAvailable: boolean;
}

type Rows = Awaited<ReturnType<typeof loadCampaignPayoutRows>>;
type PendingRow = NonNullable<Rows['ready'][number]['payout']>;

const reference = (id: number) => `LQ-${id}`;

async function pendingView(db: KorumPrismaClient, secret: string, actor: SessionActor, organizationId: string, organization: Rows['organization'], row: PendingRow, initiative: Rows['ready'][number], now: Date): Promise<PendingPayoutView> {
  const splitId = organization.paycometSplitId;
  const evaluation = await evaluateDoubleCheck(db, secret, { organizationId, targetType: 'ESCROW_PAYOUT', targetId: row.id, targetDigest: payoutDigestFor(secret, row, splitId) }, row.signatures);
  const invalid = new Set(evaluation.invalid.map((entry) => entry.signatureId));
  const valid = row.signatures.filter((signature) => !invalid.has(signature.id) && evaluation.validRoles.includes(signature.signerRole as SignerRole));
  const signers = await listSigners(db, actor, organizationId);
  const requiredRoles = requiredRolesFor(evaluation.mode);
  const slots = requiredRoles.map((role): DoubleCheckSlot => {
    const signature = valid.find((entry) => entry.signerRole === role);
    const signer = signature ? signers.find((entry) => entry.userId === signature.signerUserId && entry.role === role) : undefined;
    const holder = signers.find((entry) => entry.role === role && entry.status !== 'INVITED') ?? signers.find((entry) => entry.role === role);
    return { role, holderLabel: holder?.roleLabel?.trim() || null, signedBy: signature ? { name: signer?.name ?? '', roleLabel: signer?.roleLabel ?? null, signedAt: signature.signedAt.toISOString() } : null };
  });
  const myRoles = actor.kind === 'user' && !actor.isSuperadmin ? actor.memberships.filter((membership) => membership.organizationId === organizationId).map((membership) => membership.role) : [];
  const myRole = myRoles.length === 1 && (myRoles[0] === 'DIRECTOR' || myRoles[0] === 'COSIGNER') && requiredRoles.includes(myRoles[0]) ? myRoles[0] : null;
  const iSigned = actor.kind === 'user' && valid.some((signature) => signature.signerUserId === actor.userId);
  const challenge = actor.kind === 'user' && myRole ? await openPayoutChallengeOf(db, organizationId, row.id, actor.userId, now) : null;
  const file = row.providerInvoiceFile;
  return {
    id: row.id,
    reference: reference(row.id),
    destinationType: row.destinationType,
    beneficiaryName: row.beneficiaryName,
    ibanBank: row.beneficiaryIbanBank,
    ibanLast4: row.beneficiaryIbanLast4,
    requestedBy: signers.find((entry) => entry.userId === row.requestedById)?.name ?? null,
    netPaidCents: row.netPaidCents,
    invoice: file ? { fileId: file.id, mimeType: file.mimeType, sizeBytes: file.sizeBytes } : null,
    invoiceValid: file !== null && file.organizationId === organizationId && file.purpose === 'PROVIDER_INVOICE' && file.deletedAt === null,
    stale: !payoutFiguresMatch(row, initiative),
    updatedAt: (row.updatedAt ?? row.createdAt).toISOString(),
    signed: valid.length,
    slots,
    mySlotOpen: myRole !== null && !iSigned && !evaluation.validRoles.includes(myRole),
    myChallengeExpiresAt: challenge ? challenge.expiresAt.toISOString() : null
  };
}

export async function loadCampaignPayouts(db: KorumPrismaClient, secret: string, actor: SessionActor, organizationId: string, options: { providerPayoutAvailable: boolean }, now: Date = new Date()): Promise<CampaignPayoutsView> {
  const rows = await loadCampaignPayoutRows(db, actor, organizationId);
  const ready: ReadyInitiativeView[] = [];
  for (const initiative of rows.ready) {
    const figures = payoutFigures(initiative);
    const pending = initiative.payout && initiative.payout.status === 'PENDING_DOUBLE_CHECK' ? await pendingView(db, secret, actor, organizationId, rows.organization, initiative.payout, initiative, now) : null;
    // Si ya hay una liquidación aprobada (se está enviando), la campaña aparece en el historial, no aquí.
    if (initiative.payout && !pending) continue;
    const window = payoutWindow(initiative.firstPayinAt, now);
    ready.push({
      id: initiative.id,
      title: initiative.title,
      walletEscrowId: initiative.walletEscrowId,
      format: initiative.format,
      raisedCents: initiative.raisedCents,
      goalCents: initiative.goalCents,
      netPaidCents: figures.netPaidCents,
      korumFeeCents: figures.korumFeeSettledCents,
      gatewayInGoalCents: figures.gatewayInGoalCents,
      invoiceRequired: invoiceRequired(initiative.format),
      // Sin la cuenta de la entidad aún se puede pagar al proveedor: ese bloqueo se dice aparte (`organizationAccount`).
      blockers: await payoutBlockers(db, initiative, rows.organization, { destination: 'PROVIDER', payoutId: initiative.payout?.id ?? null, now }),
      window: window ? { deadline: window.deadline.toISOString(), daysLeft: window.daysLeft } : null,
      pending
    });
  }
  const history = rows.history.map((row): PayoutHistoryView => {
    const doneCents = row.splits.filter((split) => split.status === 'DONE').reduce((sum, split) => sum + split.amountCents, 0);
    const underReview = row.splits.some((split) => split.status === 'SENDING' || (split.status === 'FAILED' && BLOCKED_PAYOUT_SPLIT_MESSAGES.some((message) => split.errorMessage?.startsWith(message))));
    return {
      id: row.id,
      reference: reference(row.id),
      initiativeId: row.initiative.id,
      title: row.initiative.title,
      walletEscrowId: row.initiative.walletEscrowId,
      status: row.status as HistoryStatus,
      destinationType: row.destinationType,
      beneficiaryName: row.beneficiaryName,
      ibanBank: row.beneficiaryIbanBank,
      ibanLast4: row.beneficiaryIbanLast4,
      netPaidCents: row.netPaidCents,
      doneCents,
      executedAt: row.executedAt?.toISOString() ?? null,
      underReview,
      photosMissing: row.initiative.status === 'CLOSED' && (row.initiative.beforeFileId === null || row.initiative.afterFileId === null)
    };
  });
  return {
    ready,
    history,
    payable: rows.organization.kybStatus === 'VERIFIED' && rows.organization.archivedAt === null,
    organizationAccount: rows.organization.paycometSplitId !== null,
    providerPayoutAvailable: options.providerPayoutAvailable
  };
}
