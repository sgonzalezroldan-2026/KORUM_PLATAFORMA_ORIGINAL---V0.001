import type { Db } from '@/lib/db';

/**
 * Email de un desafío de doble firma (`doubleCheck.pending`): el enlace de un solo uso y el OTP se escriben en la bandeja de salida dentro de la
 * misma transacción que crea el desafío, y nunca salen hacia el navegador. Separado de `double-check.service.ts` para que cada módulo tenga una
 * sola responsabilidad.
 */

export type SignatureTarget = { targetType: 'IDEA_APPROVAL'; ideaId: number } | { targetType: 'ESCROW_PAYOUT'; payoutId: number };

const targetWhere = (target: SignatureTarget) => (target.targetType === 'IDEA_APPROVAL' ? { targetType: target.targetType, ideaId: target.ideaId } : { targetType: target.targetType, payoutId: target.payoutId });

/**
 * Anula los desafíos abiertos de un objetivo (de una persona, o de todas si no se indica) y cancela y vacía sus emails si aún no han salido: un
 * enlace anulado no debe llegar a ninguna bandeja. Lo usan pedir un enlace nuevo y rechazar una idea que esperaba la doble firma.
 */
export async function revokeOpenChallenges(tx: Db, target: SignatureTarget, now: Date, signerUserId?: string): Promise<number> {
  const open = { ...targetWhere(target), ...(signerUserId ? { signerUserId } : {}), consumedAt: null, revokedAt: null };
  const superseded = await tx.doubleCheckChallenge.findMany({ where: open, select: { id: true } });
  if (superseded.length === 0) return 0;
  await tx.doubleCheckChallenge.updateMany({ where: { id: { in: superseded.map((old) => old.id) } }, data: { revokedAt: now } });
  await tx.outboxMessage.updateMany({ where: { idempotencyKey: { in: superseded.map((old) => outboxKeyOf(old.id)) }, status: { in: ['PENDING', 'SENDING', 'FAILED'] } }, data: { status: 'CANCELLED', payloadJson: {} } });
  return superseded.length;
}

/** Clave del email de un desafío: quien anula desafíos (un rechazo, un enlace nuevo) cancela también su email si aún no ha salido. */
export const outboxKeyOf = (challengeId: string) => `doubleCheck.pending:${challengeId}`;

/** Escribe el enlace y el código en la bandeja de salida, en la misma transacción que el desafío: o existen los dos o ninguno. */
export async function queueChallengeEmail(tx: Db, target: SignatureTarget, organizationId: string, signerUserId: string, challengeId: string, secrets: { token: string; otp: string; expiresAt: Date }): Promise<number> {
  const signer = await tx.user.findUniqueOrThrow({ where: { id: signerUserId }, select: { email: true, locale: true } });
  const title =
    target.targetType === 'IDEA_APPROVAL'
      ? (await tx.idea.findUniqueOrThrow({ where: { id: target.ideaId }, select: { title: true } })).title
      : (await tx.escrowPayout.findUniqueOrThrow({ where: { id: target.payoutId }, select: { initiative: { select: { title: true } } } })).initiative.title;
  const message = await tx.outboxMessage.create({
    data: {
      idempotencyKey: outboxKeyOf(challengeId),
      templateKey: 'doubleCheck.pending',
      locale: signer.locale,
      toAddress: signer.email,
      userId: signerUserId,
      organizationId,
      payloadJson: { targetType: target.targetType, targetTitle: title.slice(0, 200), token: secrets.token, otp: secrets.otp, expiresAt: secrets.expiresAt.toISOString() }
    },
    select: { id: true }
  });
  return message.id;
}
