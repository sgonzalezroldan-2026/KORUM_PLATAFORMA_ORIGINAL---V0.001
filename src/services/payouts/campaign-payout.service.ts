import type { z } from 'zod';
import { beneficiaryDigest, CampaignPayoutError, invoiceRequired, payoutFigures, payoutInitiativeSchema, requestCampaignPayoutSchema, validateProvider } from '@/core/payouts/campaign-payout-rules';
import { sealProviderBeneficiary } from '@/core/payouts/payout-beneficiary-vault';
import type { Keyring } from '@/core/security/crypto';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { revokeOpenChallenges } from '@/core/security/double-check-email';
import { requestSignature, type SignatureReceipt } from '@/core/security/double-check.service';
import { inTransaction, type Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { CAMPAIGN_PAYOUT_RULE } from '@/lib/rate-limit-rules';
import { kybRetainUntil } from '@/core/panel/entity-settings-rules';
import { authorizeTenant, recordAudit, recordCrossTenantAttempt, recordMissingResourceProbe, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { payoutBlockers, READINESS_INITIATIVE_SELECT } from './payout-readiness';

/**
 * Pedir la liquidación de una campaña conseguida (Sprint 4.4a, skill de pagos §8, prototipo `closeAndPublishAchievedInitiative`). Una persona firmante elige
 * el destino (la cuenta de la entidad o el proveedor que eligió libremente) y adjunta la factura (o proforma) del proveedor; se fija el neto y se le envía su
 * enlace de firma. Hay una liquidación por campaña: mientras espera la doble firma se puede **cambiar** (otro destino, otra factura, o las cifras tras un
 * contracargo), y entonces las firmas que hubiera dejan de valer (su huella ya no coincide) y los enlaces abiertos se anulan.
 */

type Action = 'payout.request' | 'payout.sign_link' | 'payout.retry' | 'payout.invoice_upload';
type UserActor = Extract<SessionActor, { kind: 'user' }>;

export function parsePayoutPayload<T extends z.ZodType>(schema: T, payload: unknown): z.infer<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new CampaignPayoutError('INVALID_INPUT');
  return parsed.data;
}

/** Solo `DIRECTOR` o `COSIGNER` de **esa** entidad, con el segundo factor en esta sesión. El Super-Admin no pide ni firma por la entidad. */
export async function authorizePayoutAction(db: KorumPrismaClient, actor: SessionActor, organizationId: string, action: Action, initiativeId?: number): Promise<UserActor> {
  const target = initiativeId === undefined ? { targetType: 'Organization', targetId: organizationId } : { targetType: 'Initiative', targetId: String(initiativeId) };
  if (actor.kind !== 'user' || actor.secondFactor !== true) {
    await recordAudit(db, actor, { action: 'tenant.access_denied', organizationId, ...target, metadata: { reason: 'SECOND_FACTOR_REQUIRED', attempted: action } });
    throw new TenantAccessError(actor.kind === 'user' ? 'ROLE_NOT_ALLOWED' : 'ANONYMOUS');
  }
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action, targetType: target.targetType, ...(initiativeId === undefined ? {} : { targetId: initiativeId }), allowSuperadmin: false });
  if (initiativeId !== undefined) {
    const owner = await db.initiative.findUnique({ where: { id: initiativeId }, select: { organizationId: true } });
    // Igual que una iniciativa inexistente: no se confirma que exista en otra entidad, y queda en la auditoría.
    const probe = { organizationId, resourceType: 'Initiative', resourceId: initiativeId };
    if (!owner) {
      await recordMissingResourceProbe(db, actor, probe);
      throw new CampaignPayoutError('NOT_FOUND');
    }
    if (owner.organizationId !== organizationId) {
      await recordCrossTenantAttempt(db, actor, { ...probe, ownerOrganizationId: owner.organizationId });
      throw new CampaignPayoutError('NOT_FOUND');
    }
  }
  return actor;
}

/**
 * Límite por persona y entidad de peticiones, subidas y aperturas de factura y reintentos; al pasarlo queda en la auditoría. Por persona: una de las dos
 * firmantes no puede agotar el cupo de la otra (auditoría de seguridad del 4.4a, M1).
 */
export async function reservePayoutAttempt(db: KorumPrismaClient, actor: SessionActor, organizationId: string, kind: 'request' | 'invoice' | 'retry' | 'open', now: Date): Promise<void> {
  const who = actor.kind === 'user' ? actor.userId : 'anonymous';
  if (await reserveAttempt(db, `${CAMPAIGN_PAYOUT_RULE.prefix}${kind}:${organizationId}:${who}`, CAMPAIGN_PAYOUT_RULE, now)) return;
  await recordAudit(db, actor, { action: 'payout.rate_limited', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { kind, limit: CAMPAIGN_PAYOUT_RULE.limit } });
  throw new CampaignPayoutError('RATE_LIMITED');
}

export interface PayoutRequestDeps {
  /** `DATA_HMAC_SECRET`: huella de las firmas y del IBAN del proveedor. */
  secret: string;
  keyring: Keyring;
  /** El proveedor de pagos sabe pagar a un tercero (hoy, solo el simulador: pendiente de Paycomet). */
  providerPayoutAvailable: boolean;
}

/** La factura adjunta: de esta entidad, una factura de proveedor y sin borrar. Se comprueba aquí, al firmar y al aprobar. */
async function attachInvoice(tx: Db, organizationId: string, fileId: string, now: Date): Promise<void> {
  const file = await tx.fileAsset.findUnique({ where: { id: fileId }, select: { organizationId: true, purpose: true, deletedAt: true } });
  if (!file || file.organizationId !== organizationId || file.purpose !== 'PROVIDER_INVOICE' || file.deletedAt !== null) throw new CampaignPayoutError('INVOICE_INVALID');
  // Adjuntada a una liquidación es el justificante de un pago: se conserva 6 años (CUMPLIMIENTO §6). Subida y sin adjuntar, solo 30 días (I2).
  await tx.fileAsset.update({ where: { id: fileId }, data: { retainUntil: kybRetainUntil(now) } });
}

/**
 * La liquidación ha cambiado mientras esperaba firmas: se avisa a la otra persona firmante (quien la cambió ya lo sabe), para que nadie firme un destino
 * nuevo sin darse cuenta (auditoría de seguridad del 4.4a, I1). Sin el IBAN ni el nombre del proveedor: los ve en el panel con su sesión.
 */
async function notifyPayoutChanged(tx: Db, organizationId: string, actorUserId: string, payout: { id: number; initiativeId: number }, now: Date): Promise<void> {
  const signers = await tx.organizationMember.findMany({
    where: { organizationId, role: { in: [...SIGNER_ROLES] }, userId: { not: actorUserId }, user: { gdprAnonymizedAt: null, isSuperadmin: false } },
    select: { userId: true, user: { select: { email: true, locale: true } } }
  });
  if (signers.length === 0) return;
  await tx.outboxMessage.createMany({
    data: signers.map((signer) => ({
      idempotencyKey: `payout.changed:${payout.id}:${now.getTime()}:${signer.userId}`,
      templateKey: 'payout.changed',
      locale: signer.user.locale,
      toAddress: signer.user.email,
      userId: signer.userId,
      organizationId,
      payloadJson: { initiativeId: payout.initiativeId, payoutId: payout.id }
    })),
    skipDuplicates: true
  });
}

export async function requestCampaignPayout(
  db: KorumPrismaClient,
  deps: PayoutRequestDeps,
  actor: SessionActor,
  organizationId: string,
  payload: unknown,
  now: Date = new Date()
): Promise<{ payoutId: number; netPaidCents: number; updated: boolean; receipt: SignatureReceipt }> {
  const request = parsePayoutPayload(requestCampaignPayoutSchema, payload);
  const user = await authorizePayoutAction(db, actor, organizationId, 'payout.request', request.initiativeId);
  const provider = request.destination === 'PROVIDER' ? validateProvider(request) : null;
  if (provider && !deps.providerPayoutAvailable) throw new CampaignPayoutError('PROVIDER_PAYOUT_UNAVAILABLE');
  await reservePayoutAttempt(db, actor, organizationId, 'request', now);

  const saved = await inTransaction(db, async (tx) => {
    // La fila de la iniciativa ordena esta petición frente a un cobro, un contracargo o la aprobación de la liquidación.
    const initiative = await tx.initiative.update({ where: { id: request.initiativeId }, data: { updatedAt: now }, select: READINESS_INITIATIVE_SELECT });
    const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { legalName: true, kybStatus: true, archivedAt: true, paycometSplitId: true } });
    const existing = await tx.escrowPayout.findUnique({ where: { initiativeId: initiative.id }, select: { id: true, status: true } });
    if (existing && existing.status !== 'PENDING_DOUBLE_CHECK') throw new CampaignPayoutError('WRONG_STATUS');
    const [blocker] = await payoutBlockers(tx, initiative, organization, { destination: request.destination, payoutId: existing?.id ?? null, now });
    if (blocker) throw new CampaignPayoutError(blocker);
    if (request.invoiceFileId) await attachInvoice(tx, organizationId, request.invoiceFileId, now);
    else if (invoiceRequired(initiative.format)) throw new CampaignPayoutError('INVOICE_REQUIRED');

    const figures = payoutFigures(initiative);
    const beneficiary = provider
      ? { beneficiaryName: request.destination === 'PROVIDER' ? request.providerName : organization.legalName, ...sealProviderBeneficiary(deps.keyring, initiative.id, provider), beneficiaryDigest: beneficiaryDigest(deps.secret, provider), beneficiaryIbanLast4: provider.last4, beneficiaryIbanBank: provider.bank }
      : { beneficiaryName: organization.legalName, beneficiaryIbanEnc: null, providerCifEnc: null, beneficiaryKeyVersion: null, beneficiaryDigest: null, beneficiaryIbanLast4: null, beneficiaryIbanBank: null };
    const data = {
      destinationType: request.destination,
      ...beneficiary,
      providerInvoiceFileId: request.invoiceFileId,
      netPaidCents: figures.netPaidCents,
      korumFeeSettledCents: figures.korumFeeSettledCents,
      requestedById: user.userId,
      updatedAt: now
    };
    const payout = existing
      ? await tx.escrowPayout.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.escrowPayout.create({ data: { ...data, organizationId, initiativeId: initiative.id, createdAt: now }, select: { id: true } });
    // Lo firmado ha cambiado: los enlaces abiertos ya no sirven (las firmas guardadas tampoco, porque su huella ya no coincide).
    if (existing) {
      await revokeOpenChallenges(tx, { targetType: 'ESCROW_PAYOUT', payoutId: payout.id }, now);
      await notifyPayoutChanged(tx, organizationId, user.userId, { id: payout.id, initiativeId: initiative.id }, now);
    }
    // Ni el IBAN ni el CIF van a la auditoría (no se borra): solo el destino, el importe y si hay factura.
    await recordAudit(
      tx,
      actor,
      {
        action: existing ? 'payout.updated' : 'payout.requested',
        organizationId,
        targetType: 'EscrowPayout',
        targetId: String(payout.id),
        metadata: { initiativeId: initiative.id, destinationType: request.destination, netPaidCents: figures.netPaidCents, invoice: request.invoiceFileId !== null }
      },
      { required: true }
    );
    return { payoutId: payout.id, netPaidCents: figures.netPaidCents, updated: existing !== null };
  });
  const receipt = await requestSignature(db, deps.secret, actor, organizationId, { targetType: 'ESCROW_PAYOUT', payoutId: saved.payoutId }, now);
  return { ...saved, receipt };
}

/** Vuelve a pedir el enlace de firma propio de la liquidación de una campaña que espera la doble firma (el anterior deja de valer). */
export async function requestPayoutSignature(db: KorumPrismaClient, secret: string, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<SignatureReceipt> {
  const { initiativeId } = parsePayoutPayload(payoutInitiativeSchema, payload);
  await authorizePayoutAction(db, actor, organizationId, 'payout.sign_link', initiativeId);
  const payout = await db.escrowPayout.findUnique({ where: { initiativeId }, select: { id: true, status: true } });
  if (!payout || payout.status !== 'PENDING_DOUBLE_CHECK') throw new CampaignPayoutError('WRONG_STATUS');
  return requestSignature(db, secret, actor, organizationId, { targetType: 'ESCROW_PAYOUT', payoutId: payout.id }, now);
}
