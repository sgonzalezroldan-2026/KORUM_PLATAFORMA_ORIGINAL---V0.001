import { listPendingCosignerInvitations, revokePendingCosignerInvitations } from '@/core/onboarding/invitations';
import { cosignerCorrectionSchema, invalidFields, maskEmail, ownRoleLabelSchema, type SeatRole } from '@/core/panel/team-rules';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { inTransaction } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeTenant, recordAudit, ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { requireSigner } from './kyb.service';
import { canonicalInbox, findOrCreateInvitee, sendSeatInvitation, storedInbox, TeamRejectedError, type TeamContext } from './team-common';

/**
 * El equipo que firma en los ajustes de la entidad (Sprint 4.2e): quién ocupa cada puesto, la invitación de la cofirma si aún no la ha aceptado y el
 * relevo abierto. Y dos cambios que no necesitan el visto bueno de nadie: invitar a la cofirma mientras su puesto está vacío (solo quien dirige: no se
 * quita a nadie; corrige un email mal escrito o sustituye una invitación caducada o perdida) y el cargo visible de cada persona (el suyo propio).
 *
 * Qué se enseña: de cada persona firmante, su nombre y su cargo; de la persona invitada, el nombre que escribió quien la invitó y su email a medias
 * (`ma•••@gmail.com`). **Solo a quien tiene que dar su visto bueno** para dejar su puesto se le enseña el email completo mientras decide: es el único
 * control frente a «la otra firma pone a alguien suyo» (auditoría del 4.2e, I5). Nunca el email ni el móvil de la otra persona firmante.
 */

export interface SeatView {
  role: SeatRole;
  name: string;
  roleLabel: string | null;
  isMe: boolean;
  /** Ya tiene la app de verificación: puede firmar. */
  ready: boolean;
}

export interface HandoverView {
  id: string;
  role: SeatRole;
  status: 'AWAITING_CONSENT' | 'INVITED';
  displayName: string;
  /** Completo para quien da el visto bueno mientras decide; a medias para el resto. */
  email: string;
  roleLabel: string;
  expiresAt: string;
  expired: boolean;
  /** Lo propuso la propia persona que sale (ceder su puesto). */
  selfProposed: boolean;
  proposedByMe: boolean;
  /** Es mi puesto el que se releva. */
  outgoingIsMe: boolean;
}

export interface SignerTeamData {
  seats: SeatView[];
  pendingCosigner: { displayName: string; roleLabel: string | null; maskedEmail: string; expired: boolean } | null;
  handover: HandoverView | null;
  myRole: SeatRole | null;
  myRoleLabel: string | null;
}

export async function loadSignerTeam(db: KorumPrismaClient, actor: SessionActor, organizationId: string, now: Date = new Date()): Promise<SignerTeamData> {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'organization.team_view', targetType: 'Organization', targetId: organizationId });
  const myUserId = actor.kind === 'user' ? actor.userId : null;
  const [members, pending, handover] = await Promise.all([
    db.organizationMember.findMany({
      where: { organizationId, role: { in: [...SIGNER_ROLES] }, user: { gdprAnonymizedAt: null } },
      select: { role: true, roleLabel: true, user: { select: { id: true, name: true, twoFactorEnabled: true } } }
    }),
    listPendingCosignerInvitations(db, organizationId),
    db.signerHandover.findFirst({ where: { organizationId, status: { in: ['AWAITING_CONSENT', 'INVITED'] } } })
  ]);
  // Siempre «Dirección» y después «Cofirma», sea cual sea el orden del tipo en la base.
  const seats: SeatView[] = [...members].sort((a, b) => Number(a.role !== 'DIRECTOR') - Number(b.role !== 'DIRECTOR')).map((member) => ({ role: member.role as SeatRole, name: member.user.name, roleLabel: member.roleLabel, isMe: member.user.id === myUserId, ready: member.user.twoFactorEnabled }));
  const lastInvitation = pending.at(-1);
  const pendingUser = lastInvitation && !seats.some((seat) => seat.role === 'COSIGNER') ? await db.user.findFirst({ where: { id: lastInvitation.userId, gdprAnonymizedAt: null }, select: { email: true } }) : null;
  const incoming = handover ? await db.user.findUnique({ where: { id: handover.incomingUserId }, select: { email: true } }) : null;
  const mine = seats.find((seat) => seat.isMe) ?? null;
  const decidesNow = handover !== null && handover.status === 'AWAITING_CONSENT' && handover.outgoingUserId === myUserId && handover.expiresAt > now;

  return {
    seats,
    pendingCosigner: lastInvitation && pendingUser ? { displayName: lastInvitation.displayName ?? '', roleLabel: lastInvitation.roleLabel, maskedEmail: maskEmail(pendingUser.email), expired: lastInvitation.expired } : null,
    handover:
      handover && incoming
        ? {
            id: handover.id,
            role: handover.role as SeatRole,
            status: handover.status === 'INVITED' ? 'INVITED' : 'AWAITING_CONSENT',
            displayName: handover.displayName,
            email: decidesNow ? incoming.email : maskEmail(incoming.email),
            roleLabel: handover.roleLabel,
            expiresAt: handover.expiresAt.toISOString(),
            expired: handover.expiresAt <= now,
            selfProposed: handover.proposedByUserId === handover.outgoingUserId,
            proposedByMe: handover.proposedByUserId === myUserId,
            outgoingIsMe: handover.outgoingUserId === myUserId
          }
        : null,
    myRole: mine?.role ?? null,
    myRoleLabel: mine?.roleLabel ?? null
  };
}

/**
 * Quien dirige invita a la cofirma mientras su puesto esté vacío: corrige un email mal escrito, sustituye una invitación caducada (la purga semanal la
 * borra) o invita de nuevo si se perdió (auditoría del 4.2e, I4). La anterior deja de valer. Con la cofirma ya activa no se puede: eso es un relevo, con
 * su visto bueno. Decide quién será la segunda firma, así que exige el código reciente (I3).
 */
export async function correctCosignerInvitation(db: KorumPrismaClient, actor: SessionActor, organizationId: string, raw: unknown, context: TeamContext): Promise<void> {
  const signer = await requireSigner(db, actor, organizationId, 'signer.cosigner_invitation_correct');
  if (!signer.memberships.some((membership) => membership.organizationId === organizationId && membership.role === 'DIRECTOR')) {
    await recordAudit(db, signer, { action: 'tenant.access_denied', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { reason: 'ROLE_NOT_ALLOWED', attempted: 'signer.cosigner_invitation_correct' } });
    throw new TenantAccessError('ROLE_NOT_ALLOWED');
  }
  if (!context.secondFactorFresh) throw new TeamRejectedError('REAUTH_REQUIRED');
  const parsed = cosignerCorrectionSchema.safeParse(raw);
  if (!parsed.success) throw new TeamRejectedError('INVALID', invalidFields(parsed.error));
  const input = parsed.data;
  const canonical = canonicalInbox(input.email);
  const now = context.now ?? new Date();
  const queued: number[] = [];

  await inTransaction(db, async (tx) => {
    await tx.organization.updateMany({ where: { id: organizationId }, data: { updatedAt: now } });
    const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true, contentLocale: true } });
    const seats = await tx.organizationMember.findMany({ where: { organizationId, role: { in: [...SIGNER_ROLES] } }, select: { role: true, userId: true, user: { select: { email: true } } } });
    // El cargo de quien invita, comprobado con la entidad bloqueada: una persona recién relevada ya no invita a nadie.
    if (!seats.some((seat) => seat.role === 'DIRECTOR' && seat.userId === signer.userId)) throw new TenantAccessError('ROLE_NOT_ALLOWED');
    if (seats.some((seat) => seat.role === 'COSIGNER')) throw new TeamRejectedError('SEAT_TAKEN');
    if (seats.some((seat) => storedInbox(seat.user.email) === canonical)) throw new TeamRejectedError('SAME_INBOX', ['email']);
    const invitee = await findOrCreateInvitee(tx, { name: input.name, email: input.email, canonical, locale: organization.contentLocale });
    // Quien entra en un relevo abierto no puede recibir además la invitación de cofirma: una sustituiría a la otra.
    if ((await tx.signerHandover.count({ where: { organizationId, incomingUserId: invitee.userId, status: { in: ['AWAITING_CONSENT', 'INVITED'] } } })) > 0) throw new TeamRejectedError('INVITEE_BUSY', ['email']);
    const previous = await revokePendingCosignerInvitations(tx, organizationId);
    await sendSeatInvitation(tx, context, queued, { invitee, organizationId, organizationName: organization.name, roleLabel: input.roleLabel, displayName: input.name, handoverId: null }, now);
    await recordAudit(tx, signer, { action: 'signer.cosigner_invitation_corrected', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { replaced: previous.length, sameAccount: previous.includes(invitee.userId) } }, { required: true });
  });
  context.dispatch(queued);
}

/** Cada persona firmante cambia su propio cargo visible (el rol no cambia: eso sería un relevo). */
export async function updateOwnRoleLabel(db: KorumPrismaClient, actor: SessionActor, organizationId: string, raw: unknown): Promise<string> {
  const signer = await requireSigner(db, actor, organizationId, 'signer.role_label_update');
  const parsed = ownRoleLabelSchema.safeParse(raw);
  if (!parsed.success) throw new TeamRejectedError('INVALID', invalidFields(parsed.error));
  return inTransaction(db, async (tx) => {
    const member = await tx.organizationMember.findFirst({ where: { organizationId, userId: signer.userId, role: { in: [...SIGNER_ROLES] } }, select: { id: true, role: true, roleLabel: true } });
    if (!member) throw new ResourceNotFoundError('Cargo');
    // `roleLabel` sí se puede actualizar: el trigger solo impide cambiar el rol, la persona o la entidad de la fila.
    await tx.organizationMember.update({ where: { id: member.id }, data: { roleLabel: parsed.data.roleLabel } });
    await recordAudit(tx, signer, { action: 'signer.role_label_updated', organizationId, targetType: 'OrganizationMember', targetId: String(member.id), metadata: { role: member.role, before: member.roleLabel, after: parsed.data.roleLabel } }, { required: true });
    return parsed.data.roleLabel;
  });
}
