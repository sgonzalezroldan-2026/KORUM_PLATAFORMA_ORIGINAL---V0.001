import type { Db } from '@/lib/db';

/**
 * Escritura en la bandeja de salida de los emails que provoca el flujo del dinero. Siempre dentro de la transacción del cambio que los
 * origina (el asiento y el aviso se confirman juntos o no se confirma nada) y con clave de idempotencia: repetir el webhook no duplica el
 * email. El envío lo hace `dispatchOutbox`. Los avisos a quienes firman están en `src/core/jobs/notify.ts`.
 */

/** Destinatario de una aportación: la cuenta si la hay, o el email de invitado. `null` si no hay a quién escribir. */
async function recipientOf(tx: Db, contribution: { userId: string | null; guestEmail: string | null }): Promise<string | null> {
  if (contribution.guestEmail) return contribution.guestEmail;
  if (!contribution.userId) return null;
  const user = await tx.user.findUnique({ where: { id: contribution.userId }, select: { email: true, gdprAnonymizedAt: true } });
  return user && !user.gdprAnonymizedAt ? user.email : null;
}

/**
 * Recibo de una donación confirmada (`contribution.receipt`). Las entradas llevan su propio email con el QR (`ticket.pass`). Un mes de Mi Hucha
 * lleva el suyo (`pledge.charged`): el mismo recibo más el mes, la gestión y el enlace para pausar o cambiar.
 */
export async function queueContributionReceipt(tx: Db, contributionId: number): Promise<void> {
  const contribution = await tx.contribution.findUniqueOrThrow({
    where: { id: contributionId },
    select: {
      id: true,
      type: true,
      organizationId: true,
      initiativeId: true,
      userId: true,
      guestEmail: true,
      locale: true,
      amountCents: true,
      guaranteeContributionCents: true,
      totalChargedCents: true,
      groupName: true,
      paycometOrder: true,
      pledgeCycle: true,
      walletSubscription: { select: { totalMonths: true } },
      organization: { select: { ley49: true, ley49VerifiedAt: true } }
    }
  });
  if (contribution.type !== 'DONATION' || !contribution.paycometOrder) return;
  const toAddress = await recipientOf(tx, contribution);
  if (!toAddress) return;
  // Certificado fiscal solo si el régimen está acreditado (Regla 02 §9); si no, justificante nominativo.
  const fiscalCertificate = contribution.organization.ley49 && contribution.organization.ley49VerifiedAt !== null;
  if (contribution.walletSubscription && contribution.pledgeCycle !== null) {
    await tx.outboxMessage.createMany({
      data: [
        {
          idempotencyKey: `pledge.charged:${contribution.id}`,
          templateKey: 'pledge.charged',
          locale: contribution.locale,
          toAddress,
          userId: contribution.userId,
          organizationId: contribution.organizationId,
          payloadJson: {
            initiativeId: contribution.initiativeId,
            amountCents: contribution.amountCents,
            feeCents: contribution.totalChargedCents - contribution.amountCents,
            totalCents: contribution.totalChargedCents,
            reference: contribution.paycometOrder,
            cycle: contribution.pledgeCycle,
            totalMonths: contribution.walletSubscription.totalMonths,
            fiscalCertificate
          }
        }
      ],
      skipDuplicates: true
    });
    return;
  }
  await tx.outboxMessage.createMany({
    data: [
      {
        idempotencyKey: `contribution.receipt:${contribution.id}`,
        templateKey: 'contribution.receipt',
        locale: contribution.locale,
        toAddress,
        userId: contribution.userId,
        organizationId: contribution.organizationId,
        payloadJson: {
          initiativeId: contribution.initiativeId,
          amountCents: contribution.amountCents,
          guaranteeCents: contribution.guaranteeContributionCents,
          totalCents: contribution.totalChargedCents,
          reference: contribution.paycometOrder,
          groupName: contribution.groupName,
          fiscalCertificate
        }
      }
    ],
    skipDuplicates: true
  });
}

/** Aviso de que el dinero ya vuelve al medio de pago (`refund.issued`). Se escribe cuando el reembolso queda asentado. */
export async function queueRefundIssued(tx: Db, contributionId: number): Promise<void> {
  const contribution = await tx.contribution.findUniqueOrThrow({
    where: { id: contributionId },
    select: { id: true, organizationId: true, initiativeId: true, userId: true, guestEmail: true, locale: true, totalChargedCents: true }
  });
  const toAddress = await recipientOf(tx, contribution);
  if (!toAddress) return;
  await tx.outboxMessage.createMany({
    data: [
      {
        idempotencyKey: `refund.issued:${contribution.id}`,
        templateKey: 'refund.issued',
        locale: contribution.locale,
        toAddress,
        userId: contribution.userId,
        organizationId: contribution.organizationId,
        payloadJson: { initiativeId: contribution.initiativeId, amountCents: contribution.totalChargedCents }
      }
    ],
    skipDuplicates: true
  });
}
