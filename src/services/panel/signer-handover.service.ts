import { hasPendingInvitation, revokeHandoverInvitation } from '@/core/onboarding/invitations';
import { HANDOVER_CONSENT_DAYS, handoverProposalSchema, invalidFields } from '@/core/panel/team-rules';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { inTransaction, type Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { recordAudit, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { requireSigner } from './kyb.service';
import { canonicalInbox, findOrCreateInvitee, queueHandoverNotice, sendSeatInvitation, storedInbox, TeamRejectedError, type TeamContext } from './team-common';

/**
 * Relevo de las personas firmantes (Sprint 4.2e, decisión del promotor del 2026-11-09):
 *
 * - **Ceder el propio puesto:** quien firma propone a la persona que le sustituye; la invitación sale al momento. Sigue firmando hasta que esa
 *   persona acepta (entonces se completa el relevo, `completeHandoverInTx`).
 * - **Proponer el relevo de la otra persona:** queda `AWAITING_CONSENT` y le llega un aviso; solo cuando ella da su visto bueno (con su código)
 *   sale la invitación. Puede rechazarlo. Si no responde en 7 días, caduca: lo resuelve soporte con el Super-Admin. Así la doble firma nunca se
 *   vacía ni cambia de manos desde una sola cuenta.
 * - Proponer y dar el visto bueno exigen el **código de la app de verificación en los últimos 10 minutos** (`secondFactorFresh`); rechazar o
 *   cancelar (que dejan todo como estaba) bastan con la sesión con segundo factor. Un solo relevo abierto por entidad (índice único parcial).
 * - Reenviar solo da otra invitación a un relevo **vigente**: uno caducado no resucita con un visto bueno antiguo (auditoría del 4.2e, I2).
 * - Nadie ocupa los dos puestos ni comparte bandeja con la otra firma; el Super-Admin solo lo ve. Todo pasa con la fila de la entidad bloqueada y con
 *   el cargo de quien actúa comprobado dentro (quien acaba de ser relevada ya no propone ni retira nada).
 */

const OPEN = ['AWAITING_CONSENT', 'INVITED'] as const;
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
  const open = await tx.signerHandover.findMany({ where: { organizationId, status: { in: [...OPEN] } }, select: { id: true, expiresAt: true, outgoingMemberId: true, incomingUserId: true } });
  let closed = 0;
  for (const handover of open) {
    const seatKept = (await tx.organizationMember.count({ where: { id: handover.outgoingMemberId, organizationId } })) === 1;
    if (handover.expiresAt > now && seatKept) continue;
    await revokeHandoverInvitation(tx, handover.incomingUserId, organizationId, handover.id);
    await tx.signerHandover.update({ where: { id: handover.id }, data: { status: 'EXPIRED', closedAt: now } });
    closed += 1;
  }
  return closed;
}

/** Un intento de dar o negar el visto bueno por otra persona (o sobre un relevo que ya no espera) queda en la auditoría (auditoría del 4.2e, M3). */
async function denyConsent(db: Db, signer: SessionActor, organizationId: string, handoverId: string, attempted: string): Promise<never> {
  await recordAudit(db, signer, { action: 'tenant.access_denied', organizationId, targetType: 'SignerHandover', targetId: handoverId, metadata: { reason: 'NOT_OUTGOING_OR_NOT_OPEN', attempted } });
  throw new TeamRejectedError('NOT_FOUND');
}

export async function proposeHandover(db: KorumPrismaClient, actor: SessionActor, organizationId: string, raw: unknown, context: TeamContext): Promise<{ handoverId: string; status: 'INVITED' | 'AWAITING_CONSENT' }> {
  const signer = await requireSigner(db, actor, organizationId, 'signer.handover_propose');
  if (!context.secondFactorFresh) throw new TeamRejectedError('REAUTH_REQUIRED');
  const parsed = handoverProposalSchema.safeParse(raw);
  if (!parsed.success) throw new TeamRejectedError('INVALID', invalidFields(parsed.error));
  const input = parsed.data;
  const canonical = canonicalInbox(input.email);
  const now = context.now ?? new Date();
  const queued: number[] = [];

  const result = await inTransaction(db, async (tx) => {
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
        status: self ? 'INVITED' : 'AWAITING_CONSENT',
        consentedAt: self ? now : null,
        expiresAt: new Date(now.getTime() + HANDOVER_CONSENT_DAYS * DAY_MS)
      },
      select: { id: true, status: true }
    });
    if (self) {
      const expiresAt = await sendSeatInvitation(tx, context, queued, { invitee, organizationId, organizationName: organization.name, roleLabel: input.roleLabel, displayName: input.name, handoverId: handover.id }, now);
      await tx.signerHandover.update({ where: { id: handover.id }, data: { expiresAt } });
    } else {
      const id = await queueHandoverNotice(tx, { handoverId: handover.id, organizationId, recipientUserId: outgoing.userId, stage: 'REQUESTED', role: input.role, roleLabel: input.roleLabel });
      if (id !== null) queued.push(id);
    }
    // Sin el email ni el nombre de la persona invitada: la auditoría se conserva más que el relevo.
    await recordAudit(tx, signer, { action: 'signer.handover_proposed', organizationId, targetType: 'SignerHandover', targetId: handover.id, metadata: { role: input.role, self, outgoingMemberId: outgoing.id } }, { required: true });
    return { handoverId: handover.id, status: handover.status === 'INVITED' ? ('INVITED' as const) : ('AWAITING_CONSENT' as const) };
  });
  context.dispatch(queued);
  return result;
}

/** Quien sale da su visto bueno (con su código): sale la invitación a la persona nueva. */
export async function consentHandover(db: KorumPrismaClient, actor: SessionActor, organizationId: string, handoverId: string, context: TeamContext): Promise<void> {
  const signer = await requireSigner(db, actor, organizationId, 'signer.handover_consent');
  if (!context.secondFactorFresh) throw new TeamRejectedError('REAUTH_REQUIRED');
  const now = context.now ?? new Date();
  const queued: number[] = [];
  const found = await inTransaction(db, async (tx) => {
    const organization = await lockOrganization(tx, organizationId, now);
    await expireStaleHandovers(tx, organizationId, now);
    const handover = await tx.signerHandover.findFirst({ where: { id: handoverId, organizationId, status: 'AWAITING_CONSENT', outgoingUserId: signer.userId } });
    if (!handover) return false;
    const invitee = await tx.user.findFirst({ where: { id: handover.incomingUserId, gdprAnonymizedAt: null, isSuperadmin: false }, select: { email: true, locale: true } });
    if (!invitee) throw new TeamRejectedError('UNAVAILABLE');
    const seats = await seatsOf(tx, organizationId);
    if (seats.some((seat) => seat.userId === handover.incomingUserId || storedInbox(seat.user.email) === storedInbox(invitee.email))) throw new TeamRejectedError('SAME_INBOX');
    if (await hasPendingInvitation(tx, handover.incomingUserId, organizationId, now)) throw new TeamRejectedError('INVITEE_BUSY');
    await tx.signerHandover.update({ where: { id: handover.id }, data: { status: 'INVITED', consentedAt: now } });
    const expiresAt = await sendSeatInvitation(
      tx,
      context,
      queued,
      { invitee: { userId: handover.incomingUserId, email: invitee.email, locale: invitee.locale }, organizationId, organizationName: organization.name, roleLabel: handover.roleLabel, displayName: handover.displayName, handoverId: handover.id },
      now
    );
    await tx.signerHandover.update({ where: { id: handover.id }, data: { expiresAt } });
    await recordAudit(tx, signer, { action: 'signer.handover_consented', organizationId, targetType: 'SignerHandover', targetId: handover.id, metadata: { role: handover.role } }, { required: true });
    return true;
  });
  if (!found) await denyConsent(db, signer, organizationId, handoverId, 'signer.handover_consent');
  context.dispatch(queued);
}

/** Quien sale no está de acuerdo: el relevo se cierra y se avisa a quien lo propuso. */
export async function declineHandover(db: KorumPrismaClient, actor: SessionActor, organizationId: string, handoverId: string, context: Pick<TeamContext, 'dispatch' | 'now'>): Promise<void> {
  const signer = await requireSigner(db, actor, organizationId, 'signer.handover_decline');
  const now = context.now ?? new Date();
  const queued: number[] = [];
  const found = await inTransaction(db, async (tx) => {
    const { count } = await tx.signerHandover.updateMany({ where: { id: handoverId, organizationId, status: 'AWAITING_CONSENT', outgoingUserId: signer.userId }, data: { status: 'DECLINED', closedAt: now } });
    if (count !== 1) return false;
    const handover = await tx.signerHandover.findUniqueOrThrow({ where: { id: handoverId }, select: { role: true, roleLabel: true, proposedByUserId: true } });
    const id = await queueHandoverNotice(tx, { handoverId, organizationId, recipientUserId: handover.proposedByUserId, stage: 'DECLINED', role: handover.role, roleLabel: handover.roleLabel });
    if (id !== null) queued.push(id);
    await recordAudit(tx, signer, { action: 'signer.handover_declined', organizationId, targetType: 'SignerHandover', targetId: handoverId, metadata: { role: handover.role } }, { required: true });
    return true;
  });
  if (!found) await denyConsent(db, signer, organizationId, handoverId, 'signer.handover_decline');
  context.dispatch(queued);
}

/** Cualquiera de las dos personas firmantes retira un relevo abierto: todo sigue como estaba y el enlace de la invitación deja de valer. */
export async function cancelHandover(db: KorumPrismaClient, actor: SessionActor, organizationId: string, handoverId: string, now: Date = new Date()): Promise<void> {
  const signer = await requireSigner(db, actor, organizationId, 'signer.handover_cancel');
  await inTransaction(db, async (tx) => {
    await lockOrganization(tx, organizationId, now);
    await assertStillSigner(tx, organizationId, signer.userId);
    const handover = await tx.signerHandover.findFirst({ where: { id: handoverId, organizationId, status: { in: [...OPEN] } }, select: { role: true, incomingUserId: true } });
    if (!handover) throw new TeamRejectedError('NOT_FOUND');
    await revokeHandoverInvitation(tx, handover.incomingUserId, organizationId, handoverId);
    await tx.signerHandover.update({ where: { id: handoverId }, data: { status: 'CANCELLED', closedAt: now } });
    await recordAudit(tx, signer, { action: 'signer.handover_cancelled', organizationId, targetType: 'SignerHandover', targetId: handoverId, metadata: { role: handover.role } }, { required: true });
  });
}

/** Nueva invitación (72 horas más) para un relevo **vigente** ya aceptado por quien sale: la anterior deja de valer. Uno caducado se vuelve a proponer. */
export async function resendHandoverInvitation(db: KorumPrismaClient, actor: SessionActor, organizationId: string, handoverId: string, context: Omit<TeamContext, 'secondFactorFresh'>): Promise<void> {
  const signer = await requireSigner(db, actor, organizationId, 'signer.handover_resend');
  const now = context.now ?? new Date();
  const queued: number[] = [];
  // El cierre de un relevo caducado se guarda aunque no se reenvíe nada (por eso no se lanza dentro de la transacción).
  const found = await inTransaction(db, async (tx) => {
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
  });
  if (!found) throw new TeamRejectedError('NOT_FOUND');
  context.dispatch(queued);
}
