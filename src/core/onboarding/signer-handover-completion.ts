import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import type { Db } from '@/lib/db';

/**
 * Último paso de un relevo de firmantes (Sprint 4.2e, heredado del 3.2): la persona nueva acepta su invitación. Se llama **dentro** de la
 * transacción que consume el enlace (`invitations.ts`), así que o pasa todo o no pasa nada:
 *
 * 1. El relevo pasa a `COMPLETED` solo si sigue invitado, no ha caducado y es para esta persona (un borrado condicional: dos aceptaciones a la vez
 *    no hacen dos veces el trabajo).
 * 2. Se da de **baja la fila del cargo de quien sale** (nunca se edita: lo impide un trigger). Sus firmas pendientes dejan de valer solas, porque
 *    están atadas a esa fila (`membershipId`), y sus enlaces de firma abiertos se anulan.
 * 3. Se crea la fila de la persona nueva con su cargo. Una misma persona nunca ocupa los dos puestos ni comparte bandeja con la otra firma.
 * 4. Al relevar a quien dirige, el email y el móvil de contacto del alta (que son suyos) pasan al email de la persona nueva y se vacía el móvil.
 * 5. Aviso a quien sale y a quien sigue firmando, y el rastro en la auditoría.
 */

export type HandoverCompletionFailure = 'NOT_OPEN' | 'SEAT_CHANGED' | 'HOLDS_OTHER_SEAT' | 'SAME_INBOX';

export class HandoverCompletionError extends Error {
  constructor(readonly reason: HandoverCompletionFailure) {
    super(`No se puede completar el relevo: ${reason}.`);
    this.name = 'HandoverCompletionError';
  }
}

const inboxOf = (email: string) => {
  try {
    return normalizeCanonicalEmail(email);
  } catch {
    return email.trim().toLowerCase();
  }
};

/** Lo que se comprueba también antes de enseñar la invitación: el puesto sigue siendo de quien salía y la persona nueva puede ocuparlo. */
export async function handoverStillValid(db: Db, handoverId: string, incomingUserId: string, now: Date): Promise<HandoverCompletionFailure | null> {
  const handover = await db.signerHandover.findUnique({
    where: { id: handoverId }
  });
  if (!handover || handover.status !== 'INVITED' || handover.expiresAt <= now || handover.incomingUserId !== incomingUserId) return 'NOT_OPEN';
  const [outgoing, signers, incoming] = await Promise.all([
    db.organizationMember.findFirst({
      where: {
        id: handover.outgoingMemberId,
        organizationId: handover.organizationId,
        role: handover.role,
        userId: handover.outgoingUserId
      },
      select: { id: true }
    }),
    db.organizationMember.findMany({
      where: {
        organizationId: handover.organizationId,
        role: { in: [...SIGNER_ROLES] }
      },
      select: { id: true, userId: true, user: { select: { email: true } } }
    }),
    db.user.findUnique({
      where: { id: incomingUserId },
      select: { email: true }
    })
  ]);
  if (!outgoing) return 'SEAT_CHANGED';
  if (!incoming) return 'NOT_OPEN';
  const staying = signers.filter((signer) => signer.id !== handover.outgoingMemberId);
  if (staying.some((signer) => signer.userId === incomingUserId)) return 'HOLDS_OTHER_SEAT';
  const inbox = inboxOf(incoming.email);
  if (staying.some((signer) => inboxOf(signer.user.email) === inbox)) return 'SAME_INBOX';
  return null;
}

export async function completeHandoverInTx(tx: Db, handoverId: string, incomingUserId: string, now: Date): Promise<void> {
  const target = await tx.signerHandover.findUnique({ where: { id: handoverId }, select: { organizationId: true } });
  if (!target) throw new HandoverCompletionError('NOT_OPEN');
  // Primero la fila de la entidad: un cambio de firmantes a la vez (otra aceptación, una propuesta, una invitación a la cofirma).
  await tx.organization.updateMany({ where: { id: target.organizationId }, data: { updatedAt: now } });
  // Con la entidad ya bloqueada se vuelve a comprobar todo (auditoría del 4.2e, I1): sigue invitado y vigente, el puesto es el mismo, y la persona
  // nueva no ocupa ya el otro puesto ni comparte bandeja con quien sigue.
  const failure = await handoverStillValid(tx, handoverId, incomingUserId, now);
  if (failure) throw new HandoverCompletionError(failure);
  const closed = await tx.signerHandover.updateMany({ where: { id: handoverId, status: 'INVITED', expiresAt: { gt: now }, incomingUserId }, data: { status: 'COMPLETED', closedAt: now } });
  if (closed.count !== 1) throw new HandoverCompletionError('NOT_OPEN');
  const handover = await tx.signerHandover.findUniqueOrThrow({ where: { id: handoverId } });

  const removed = await tx.organizationMember.deleteMany({
    where: {
      id: handover.outgoingMemberId,
      organizationId: handover.organizationId,
      role: handover.role
    }
  });
  if (removed.count !== 1) throw new HandoverCompletionError('SEAT_CHANGED');
  const member = await tx.organizationMember.create({
    data: {
      organizationId: handover.organizationId,
      userId: incomingUserId,
      role: handover.role,
      roleLabel: handover.roleLabel
    },
    select: { id: true }
  });
  const revoked = await tx.doubleCheckChallenge.updateMany({
    where: {
      organizationId: handover.organizationId,
      signerUserId: handover.outgoingUserId,
      consumedAt: null,
      revokedAt: null
    },
    data: { revokedAt: now }
  });
  if (handover.role === 'DIRECTOR') {
    const incoming = await tx.user.findUniqueOrThrow({
      where: { id: incomingUserId },
      select: { email: true }
    });
    await tx.organization.update({
      where: { id: handover.organizationId },
      data: { contactEmail: incoming.email, contactPhone: null }
    });
  }

  await tx.auditLog.create({
    data: {
      actorType: 'USER',
      actorUserId: incomingUserId,
      organizationId: handover.organizationId,
      action: 'signer.handover_completed',
      targetType: 'SignerHandover',
      targetId: handover.id,
      metadataJson: {
        role: handover.role,
        outgoingMemberId: handover.outgoingMemberId,
        outgoingUserId: handover.outgoingUserId,
        incomingMemberId: member.id,
        revokedChallenges: revoked.count
      }
    }
  });

  // Aviso a quien sale (deja de firmar) y a quien sigue en el otro puesto (ya firma con otra persona). Sin nombres: lo ven en el panel.
  const recipients = await tx.user.findMany({
    where: {
      gdprAnonymizedAt: null,
      OR: [
        { id: handover.outgoingUserId },
        {
          memberships: {
            some: {
              organizationId: handover.organizationId,
              role: { in: [...SIGNER_ROLES] },
              NOT: { userId: incomingUserId }
            }
          }
        }
      ]
    },
    select: { id: true, email: true, locale: true }
  });
  if (recipients.length > 0) {
    await tx.outboxMessage.createMany({
      data: recipients.map((recipient) => ({
        idempotencyKey: `signer.handover:${handover.id}:COMPLETED:${recipient.id}`,
        templateKey: 'signer.handover',
        locale: recipient.locale,
        toAddress: recipient.email,
        userId: recipient.id,
        organizationId: handover.organizationId,
        payloadJson: {
          stage: 'COMPLETED',
          role: handover.role,
          roleLabel: handover.roleLabel,
          leaving: recipient.id === handover.outgoingUserId
        }
      })),
      skipDuplicates: true
    });
  }
}
