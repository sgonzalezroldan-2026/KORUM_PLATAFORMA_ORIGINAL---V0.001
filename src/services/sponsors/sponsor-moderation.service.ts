import type { z } from 'zod';
import { signCheckoutResult } from '@/core/checkout/checkout-rules';
import { getAccountBalance } from '@/core/finance/ledger-balances';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { approveSponsorSchema, badgeExpiryFrom, needsDecision, rejectSponsorSchema, SponsorModerationError } from '@/core/sponsors/sponsor-moderation-rules';
import { inTransaction, type Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { requireOwnedResource } from '@/repositories/ownership';
import { authorizeTenant, recordAudit, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { RectificationNotAllowedError, rectifyInvoice } from '@/services/invoicing/invoice.service';
import { approveRefundInTx, PaymentReconciliationError, RefundNotAllowedError } from '@/services/payments/payment-reversals';
import type { InvoicingContext } from '@/services/payments/sponsorship-events';

/**
 * Moderación de comercios amigos desde el panel (Sprint 4.2b, `function moderateSponsor` del prototipo). Como las ideas: solo `DIRECTOR` o
 * `COSIGNER` de **esa** entidad, con el segundo factor en esta sesión; el Super-Admin no decide por la entidad. El comercio se pide siempre junto a
 * su entidad: uno de otra responde igual que uno inexistente y queda en la auditoría. Solo se modera un comercio **cobrado** (`paidAt`).
 *
 * Cada decisión se toma con la iniciativa bloqueada (la misma fila que bloquean los cobros, los contracargos y la liquidación), así que una
 * aprobación, un rechazo, un contracargo y una liquidación simultáneos se ordenan y ninguno ve un estado a medias.
 */

type Action = 'sponsor.approve' | 'sponsor.reject';

function parse<T extends z.ZodType>(schema: T, payload: unknown): z.infer<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new SponsorModerationError('INVALID_INPUT');
  return parsed.data;
}

async function authorizeSponsor(db: KorumPrismaClient, actor: SessionActor, organizationId: string, id: number, action: Action): Promise<string> {
  if (actor.kind !== 'user' || actor.secondFactor !== true) {
    await recordAudit(db, actor, { action: 'tenant.access_denied', organizationId, targetType: 'Sponsor', targetId: String(id), metadata: { reason: 'SECOND_FACTOR_REQUIRED', attempted: action } });
    throw new TenantAccessError(actor.kind === 'user' ? 'ROLE_NOT_ALLOWED' : 'ANONYMOUS');
  }
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action, targetType: 'Sponsor', targetId: id, allowSuperadmin: false });
  const owner = await db.sponsor.findUnique({ where: { id }, select: { organizationId: true } });
  await requireOwnedResource(db, actor, { organizationId, resourceType: 'Sponsor', resourceId: id, resourceLabel: 'Comercio', ownerOrganizationId: owner?.organizationId ?? null });
  return (actor as Extract<SessionActor, { kind: 'user' }>).userId;
}

/** Bloquea la iniciativa del comercio y lo lee después: lo que se lea ya no puede cambiar hasta confirmar. */
async function lockSponsor(tx: Db, id: number) {
  const reference = await tx.sponsor.findUniqueOrThrow({ where: { id }, select: { initiativeId: true } });
  if (reference.initiativeId === null) throw new SponsorModerationError('WRONG_STATUS');
  await tx.initiative.update({ where: { id: reference.initiativeId }, data: { updatedAt: new Date() } });
  const sponsor = await tx.sponsor.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      organizationId: true,
      initiativeId: true,
      name: true,
      email: true,
      status: true,
      paidAt: true,
      amountCents: true,
      isMatchingPool: true,
      categoryLevel: true,
      logoFileId: true,
      contribution: { select: { id: true, status: true, locale: true, paycometOrder: true, totalChargedCents: true } }
    }
  });
  // Si entre la lectura y el bloqueo el comercio pasó a otra iniciativa (reasignación, 4.2d), la fila bloqueada no es la suya: no se decide nada.
  if (sponsor.initiativeId !== reference.initiativeId) throw new SponsorModerationError('WRONG_STATUS');
  return sponsor;
}

type LockedSponsor = Awaited<ReturnType<typeof lockSponsor>>;

function assertDecidable(sponsor: LockedSponsor): asserts sponsor is LockedSponsor & { initiativeId: number; contribution: NonNullable<LockedSponsor['contribution']> & { paycometOrder: string } } {
  if (!needsDecision(sponsor) || sponsor.initiativeId === null || sponsor.contribution?.status !== 'COMPLETED' || !sponsor.contribution.paycometOrder) throw new SponsorModerationError('WRONG_STATUS');
}

/**
 * Aprueba al comercio: sale en el directorio durante 12 meses y, si eligió la bolsa Matching 2x, la bolsa se activa en la iniciativa en la misma
 * transacción (heredado del Sprint 3.5, punto 1). La bolsa debe estar entera en el libro: si no cuadra, no se activa nada.
 */
export async function approveSponsor(db: KorumPrismaClient, actor: SessionActor, organizationId: string, payload: unknown, options: { hmacSecret: string }, now: Date = new Date()): Promise<{ matching: boolean }> {
  const { sponsorId } = parse(approveSponsorSchema, payload);
  const userId = await authorizeSponsor(db, actor, organizationId, sponsorId, 'sponsor.approve');
  return inTransaction(db, async (tx) => {
    const sponsor = await lockSponsor(tx, sponsorId);
    assertDecidable(sponsor);
    // La bolsa solo se activa si la campaña sigue recaudando: en una que ya no admite donaciones nadie la liberaría. Ahí se queda en `MATCHING_POOL`
    // y la reasigna la tarea de comercios al liquidarse o devolverse la campaña (heredado del 4.2b, punto 2).
    const initiative = sponsor.isMatchingPool ? await tx.initiative.findUniqueOrThrow({ where: { id: sponsor.initiativeId }, select: { matchingPoolTotalCents: true, status: true } }) : null;
    const activatePool = initiative?.status === 'FUNDRAISING';
    if (initiative && activatePool) {
      if (initiative.matchingPoolTotalCents > 0) throw new SponsorModerationError('MATCHING_TAKEN');
      const { balanceCents } = await getAccountBalance(tx, 'MATCHING_POOL', { initiativeId: sponsor.initiativeId, sponsorId: sponsor.id });
      if (balanceCents !== sponsor.amountCents) throw new PaymentReconciliationError(`La bolsa Matching 2x del comercio ${sponsor.id} tiene ${balanceCents} céntimos y su nivel es ${sponsor.amountCents}.`);
      await tx.initiative.update({ where: { id: sponsor.initiativeId }, data: { matchingPoolTotalCents: sponsor.amountCents, matchingPoolRemainingCents: sponsor.amountCents, matchingSponsorName: sponsor.name } });
    }
    const expiresAt = badgeExpiryFrom(now);
    const { count } = await tx.sponsor.updateMany({ where: { id: sponsor.id, status: 'PENDING' }, data: { status: 'APPROVED', expiresAt } });
    if (count !== 1) throw new SponsorModerationError('WRONG_STATUS');

    const order = sponsor.contribution.paycometOrder;
    await tx.outboxMessage.createMany({
      data: [
        {
          idempotencyKey: `sponsor.welcome:${sponsor.id}`,
          templateKey: 'sponsor.welcome',
          locale: sponsor.contribution.locale,
          toAddress: sponsor.email,
          organizationId,
          payloadJson: { sponsorId: sponsor.id, level: sponsor.categoryLevel, matching: activatePool, expiresAt: expiresAt.toISOString(), order, sig: signCheckoutResult(options.hmacSecret, order) }
        }
      ],
      skipDuplicates: true
    });
    await recordAudit(tx, actor, { action: 'sponsor.approved', organizationId, targetType: 'Sponsor', targetId: String(sponsor.id), metadata: { matching: activatePool, amountCents: sponsor.amountCents, by: userId } }, { required: true });
    return { matching: activatePool };
  });
}

/**
 * Rechaza al comercio: se le devuelve el 100 % de lo cobrado (nivel, fee e IVA, reflejando el asiento del cobro) y se rectifica la factura del fee,
 * todo en una transacción. La devolución queda aprobada (`REFUND_PENDING`) y la ejecuta quien llama justo después, o la tarea `MASS_REFUND`. Sin el NIF
 * emisor o la razón social no se rechaza: una devolución sin su rectificativa dejaría una factura cobrada que ya no lo está.
 */
export async function rejectSponsor(
  db: KorumPrismaClient,
  actor: SessionActor,
  organizationId: string,
  payload: unknown,
  options: { hmacSecret: string; invoicing: InvoicingContext | undefined },
  now: Date = new Date()
): Promise<{ contributionId: number; retiredLogo: { bucket: string; objectKey: string } | null }> {
  const { sponsorId, reason } = parse(rejectSponsorSchema, payload);
  const userId = await authorizeSponsor(db, actor, organizationId, sponsorId, 'sponsor.reject');
  try {
    return await inTransaction(db, async (tx) => {
      const sponsor = await lockSponsor(tx, sponsorId);
      assertDecidable(sponsor);
      const invoice = await tx.invoice.findFirst({ where: { sponsorId: sponsor.id, invoiceType: 'F1', rectifiedBy: { is: null } }, select: { id: true } });
      if (invoice && !options.invoicing) throw new SponsorModerationError('INVOICING_UNAVAILABLE');

      await approveRefundInTx(tx, sponsor.contribution.id, { at: now });
      // Un comercio no admitido no se publica: si el centro ya había subido su logotipo, se retira (quien llama borra el objeto del almacén).
      await tx.sponsor.update({ where: { id: sponsor.id }, data: { status: 'REJECTED', logoFileId: null } });
      const retiredLogo = sponsor.logoFileId ? await tx.fileAsset.update({ where: { id: sponsor.logoFileId }, data: { deletedAt: now }, select: { bucket: true, objectKey: true } }) : null;
      if (invoice && options.invoicing) {
        await rectifyInvoice(
          tx,
          { invoiceId: invoice.id, issuerTaxId: options.invoicing.issuerTaxId, issuerName: options.invoicing.issuerName, keyring: options.invoicing.keyring, concept: 'Anulación del servicio de gestión publicitaria: la entidad no ha admitido el patrocinio' },
          now
        );
      }
      const order = sponsor.contribution.paycometOrder;
      await tx.outboxMessage.createMany({
        data: [
          {
            idempotencyKey: `sponsor.rejected:${sponsor.id}`,
            templateKey: 'sponsor.rejected',
            locale: sponsor.contribution.locale,
            toAddress: sponsor.email,
            organizationId,
            payloadJson: { sponsorId: sponsor.id, reason, refundCents: sponsor.contribution.totalChargedCents, rectified: invoice !== null, order, sig: signCheckoutResult(options.hmacSecret, order) }
          }
        ],
        skipDuplicates: true
      });
      // El motivo no se guarda en la auditoría (es texto libre y la auditoría no se borra nunca): solo su longitud.
      await recordAudit(
        tx,
        actor,
        { action: 'sponsor.rejected', organizationId, targetType: 'Sponsor', targetId: String(sponsor.id), metadata: { refundCents: sponsor.contribution.totalChargedCents, rectified: invoice !== null, reasonLength: reason.length, by: userId } },
        { required: true }
      );
      return { contributionId: sponsor.contribution.id, retiredLogo };
    });
  } catch (error) {
    if (error instanceof RefundNotAllowedError) throw new SponsorModerationError('ALREADY_SETTLED');
    // Cambió el NIF emisor desde la factura del fee: la rectificativa la tiene que emitir el mismo obligado, así que se resuelve a mano (soporte).
    if (error instanceof RectificationNotAllowedError) throw new SponsorModerationError('INVOICING_UNAVAILABLE');
    throw error;
  }
}
