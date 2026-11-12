import { hasPendingInvitation, revokeHandoverInvitation } from '@/core/onboarding/invitations';
import { handoverProposalSchema, invalidFields } from '@/core/panel/team-rules';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { inTransaction, type Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { recordAudit, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { requireSigner } from './kyb.service';
import { canonicalInbox, findOrCreateInvitee, queueHandoverNotice, sendSeatInvitation, storedInbox, TeamRejectedError, type TeamContext } from './team-common';

/**
 * Relevo de las personas firmantes (Sprint 4.2e, rediseñado el 2026-11-12 por decisión del promotor): **lo resuelve la propia entidad, sin esperas ni visto bueno
 * de nadie y sin que intervenga el Super-Admin**.
 *
 * - **Ceder el propio puesto o sustituir a la otra firma:** cualquiera de las dos personas que firman propone a la persona nueva y la invitación sale al
 *   momento. Quien sale sigue firmando hasta que la persona nueva acepta; entonces el cambio es inmediato (`completeHandoverInTx`). Esto incluye que la
 *   Cofirma sustituya a la Dirección si esta ya no está.
 * - A quien sale (si no es quien lo propone) le llega un aviso por email y el cambio queda en la auditoría de la entidad, que ella no puede borrar. No tiene
 *   veto: solo quien lo propuso puede retirarlo antes de que la persona nueva acepte.
 * - Proponer exige el **código de la app de verificación en los últimos 10 minutos** (`secondFactorFresh`). Un solo relevo abierto por entidad (índice único
 *   parcial). La invitación vale 72 horas; caducada, se vuelve a proponer.
 * - Nadie ocupa los dos puestos ni comparte bandeja con la otra firma. Todo pasa con la fila de la entidad bloqueada y con el cargo de quien actúa comprobado
 *   dentro (quien acaba de ser relevada ya no propone ni retira nada).
 */

const OPEN = ['AWAITING_CONSENT', 'INVITED'] as const; // AWAITING_CONSENT ya no se crea; se conserva por los relevos antiguos.
const DAY_MS = 86_400_000;

/** Bloquea la fila de la entidad: los cambios del equipo que firma van de uno en uno. */
async function lockOrganization(tx: Db, organizationId: string, now: Date) {
  await tx.organization.updateMany({ where: { id: organizationId }, data: { updatedAt: now } });
  return tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true, contentLocale: true } });
}

const seatsOf = (tx: Db, organizationId: string) =>
  tx.organizationMember.findMany({ where: { organizationId, role: { in: [...SIGNER_ROLES] } }, select: { id: true, userId: true, role: true, user: { select: { email: true } } } });

/** Con la entidad bloqueada: quien actúa sigue firmando (el cargo se comprobó antes, fuera de la transacción). */
async function assertStillSigner(tx: Db, organizationId: string, userId: string): Promise<void> {
  if ((await tx.organizationMember.count({ where: { organizationId, userId, role: { in: [...SIGNER_ROLES] } } })) === 0) throw new TenantAccessError('ROLE_NOT_ALLOWED');
}

/**
 * Cierra los relevos abiertos que ya no valen: caducados, o cuyo puesto ha cambiado desde la propuesta. Primero se anula su enlace y después se cierra
 * (el mismo orden que al aceptar: invitación y después relevo, sin bloqueos cruzados).
 */
export async function expireStaleHandovers(tx: Db, organizationId: string, now: Date): Promise<number> {
  const open = await tx.signerHandover.findMany({ where: { organizationId, status: { in: [...OPEN] } }, select: { id: true, role: true, roleLabel: true, expiresAt: true, outgoingMemberId: true, incomingUserId: true, proposedByUserId: true } });
  let closed = 0;
  for (const handover of open) {
    const seatKept = (await tx.organizationMember.count({ where: { id: handover.outgoingMemberId, organizationId } })) === 1;
    if (handover.expiresAt > now && seatKept) continue;
    await revokeHandoverInvitation(tx, handover.incomingUserId, organizationId, handover.id);
    await tx.signerHandover.update({ where: { id: handover.id }, data: { status: 'EXPIRED', closedAt: now } });
    // Quien propuso un relevo que caduca sin que la persona aceptara se entera por email (la invitación desaparece del panel; sin aviso parecería un fallo).
    // El aviso espera en la bandeja y sale con la tarea; el servicio que cierra no envía nada al momento.
    if (handover.expiresAt <= now && seatKept) await queueHandoverNotice(tx, { handoverId: handover.id, organizationId, recipientUserId: handover.proposedByUserId, stage: 'EXPIRED', role: handover.role, roleLabel: handover.roleLabel });
    closed += 1;
  }
  return closed;
}

/** Un acceso denegado dentro de la transacción la deshace entera, también su registro: se anota fuera, con el motivo (auditoría de seguridad del 5.2, B5). */
async function denied<T>(db: KorumPrismaClient, signer: Parameters<typeof recordAudit>[1], organizationId: string, attempted: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TenantAccessError) await recordAudit(db, signer, { action: 'tenant.access_denied', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { reason: 'ROLE_NOT_ALLOWED', attempted } });
    throw error;
  }
}

export async function proposeHandover(db: KorumPrismaClient, actor: SessionActor, organizationId: string, raw: unknown, context: TeamContext): Promise<{ handoverId: string; status: 'INVITED' }> {
  const signer = await requireSigner(db, actor, organizationId, 'signer.handover_propose');
  if (!context.secondFactorFresh) throw new TeamRejectedError('REAUTH_REQUIRED');
  const parsed = handoverProposalSchema.safeParse(raw);
  if (!parsed.success) throw new TeamRejectedError('INVALID', invalidFields(parsed.error));
  const input = parsed.data;
  const canonical = canonicalInbox(input.email);
  const now = context.now ?? new Date();
  const queued: number[] = [];

  const result = await denied(db, signer, organizationId, 'signer.handover_propose', () => inTransaction(db, async (tx) => {
    const organization = await lockOrganization(tx, organizationId, now);
    await assertStillSigner(tx, organizationId, signer.userId);
    await expireStaleHandovers(tx, organizationId, now);
    if ((await tx.signerHandover.count({ where: { organizationId, status: { in: [...OPEN] } } })) > 0) throw new TeamRejectedError('ALREADY_OPEN');
    const seats = await seatsOf(tx, organizationId);
    const outgoing = seats.find((seat) => seat.role === input.role);
    // Un puesto vacío (la cofirma aún no ha aceptado su invitación) no se releva: se invita desde «Invitar a la cofirma».
    if (!outgoing) throw new TeamRejectedError('SEAT_EMPTY');
    if (seats.some((seat) => storedInbox(seat.user.email) === canonical)) throw new TeamRejectedError('SAME_INBOX', ['email']);
    const invitee = await findOrCreateInvitee(tx, { name: input.name, email: input.email, canonical, locale: organization.contentLocale });
    // Una invitación nueva sustituiría a la que ya tiene (por ejemplo, la de cofirma) sin avisar a nadie (auditoría del 4.2e, I4).
    if (await hasPendingInvitation(tx, invitee.userId, organizationId, now)) throw new TeamRejectedError('INVITEE_BUSY', ['email']);

    const self = outgoing.userId === signer.userId;
    const handover = await tx.signerHandover.create({
      data: {
        organizationId,
        role: input.role,
        outgoingMemberId: outgoing.id,
        outgoingUserId: outgoing.userId,
        incomingUserId: invitee.userId,
        roleLabel: input.roleLabel,
        displayName: input.name,
        proposedByUserId: signer.userId,
        status: 'INVITED',
        // Sin visto bueno de quien sale: `consentedAt` se queda vacío (solo lo llevan los relevos antiguos).
        expiresAt: new Date(now.getTime() + DAY_MS)
      },
      select: { id: true, status: true }
    });
    const expiresAt = await sendSeatInvitation(tx, context, queued, { invitee, organizationId, organizationName: organization.name, roleLabel: input.roleLabel, displayName: input.name, handoverId: handover.id }, now);
    await tx.signerHandover.update({ where: { id: handover.id }, data: { expiresAt } });
    // Quien sale, si no es quien lo propone, lo sabe al momento: puede hablarlo con la entidad, pero no tiene veto.
    if (!self) {
      const id = await queueHandoverNotice(tx, { handoverId: handover.id, organizationId, recipientUserId: outgoing.userId, stage: 'REQUESTED', role: input.role, roleLabel: input.roleLabel });
      if (id !== null) queued.push(id);
    }
    // Sin el email ni el nombre de la persona invitada: la auditoría se conserva más que el relevo.
    await recordAudit(tx, signer, { action: 'signer.handover_proposed', organizationId, targetType: 'SignerHandover', targetId: handover.id, metadata: { role: input.role, self, outgoingMemberId: outgoing.id } }, { required: true });
    return { handoverId: handover.id, status: 'INVITED' as const };
  }));
  context.dispatch(queued);
  return result;
}

/** Quien propuso el relevo lo retira mientras esté abierto: todo sigue como estaba y el enlace de la invitación deja de valer. Quien sale no puede vetarlo. */
export async function cancelHandover(db: KorumPrismaClient, actor: SessionActor, organizationId: string, handoverId: string, now: Date = new Date()): Promise<void> {
  const signer = await requireSigner(db, actor, organizationId, 'signer.handover_cancel');
  await denied(db, signer, organizationId, 'signer.handover_cancel', async () => {
    try {
      await inTransaction(db, async (tx) => {
        await lockOrganization(tx, organizationId, now);
        await assertStillSigner(tx, organizationId, signer.userId);
        const handover = await tx.signerHandover.findFirst({ where: { id: handoverId, organizationId, status: { in: [...OPEN] }, proposedByUserId: signer.userId }, select: { role: true, incomingUserId: true } });
        if (!handover) throw new TeamRejectedError('NOT_FOUND');
        await revokeHandoverInvitation(tx, handover.incomingUserId, organizationId, handoverId);
        await tx.signerHandover.update({ where: { id: handoverId }, data: { status: 'CANCELLED', closedAt: now } });
        await recordAudit(tx, signer, { action: 'signer.handover_cancelled', organizationId, targetType: 'SignerHandover', targetId: handoverId, metadata: { role: handover.role } }, { required: true });
      });
    } catch (error) {
      // Una persona firmante que intenta retirar un relevo que no propuso: el motivo no se dice a quien lo intenta, pero queda anotado.
      if (error instanceof TeamRejectedError && error.reason === 'NOT_FOUND' && (await db.signerHandover.count({ where: { id: handoverId, organizationId, status: { in: [...OPEN] } } })) > 0) {
        await recordAudit(db, signer, { action: 'tenant.access_denied', organizationId, targetType: 'SignerHandover', targetId: handoverId, metadata: { reason: 'NOT_PROPOSER', attempted: 'signer.handover_cancel' } });
      }
      throw error;
    }
  });
}

/** Nueva invitación (72 horas más) para un relevo **vigente**: la anterior deja de valer. Uno caducado se vuelve a proponer. */
export async function resendHandoverInvitation(db: KorumPrismaClient, actor: SessionActor, organizationId: string, handoverId: string, context: Omit<TeamContext, 'secondFactorFresh'>): Promise<void> {
  const signer = await requireSigner(db, actor, organizationId, 'signer.handover_resend');
  const now = context.now ?? new Date();
  const queued: number[] = [];
  // El cierre de un relevo caducado se guarda aunque no se reenvíe nada (por eso no se lanza dentro de la transacción).
  const found = await denied(db, signer, organizationId, 'signer.handover_resend', () => inTransaction(db, async (tx) => {
    const organization = await lockOrganization(tx, organizationId, now);
    await assertStillSigner(tx, organizationId, signer.userId);
    await expireStaleHandovers(tx, organizationId, now);
    const handover = await tx.signerHandover.findFirst({ where: { id: handoverId, organizationId, status: 'INVITED' } });
    if (!handover) return false;
    const invitee = await tx.user.findFirst({ where: { id: handover.incomingUserId, gdprAnonymizedAt: null, isSuperadmin: false }, select: { email: true, locale: true } });
    if (!invitee) throw new TeamRejectedError('UNAVAILABLE');
    const expiresAt = await sendSeatInvitation(
      tx,
      { ...context, secondFactorFresh: false },
      queued,
      { invitee: { userId: handover.incomingUserId, email: invitee.email, locale: invitee.locale }, organizationId, organizationName: organization.name, roleLabel: handover.roleLabel, displayName: handover.displayName, handoverId: handover.id },
      now
    );
    await tx.signerHandover.update({ where: { id: handover.id }, data: { expiresAt } });
    await recordAudit(tx, signer, { action: 'signer.handover_resent', organizationId, targetType: 'SignerHandover', targetId: handover.id, metadata: { role: handover.role } }, { required: true });
    return true;
  }));
  if (!found) throw new TeamRejectedError('NOT_FOUND');
  context.dispatch(queued);
}
