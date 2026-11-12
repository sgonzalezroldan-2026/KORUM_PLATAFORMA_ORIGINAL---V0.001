import { listPendingCosignerInvitations, revokeHandoverInvitation, revokePendingCosignerInvitations } from '@/core/onboarding/invitations';
import { cosignerCorrectionSchema, invalidFields, maskEmail, ownRoleLabelSchema, signatureModeChangeSchema, type SeatRole } from '@/core/panel/team-rules';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { convertReadyIdeas } from '@/core/security/double-check.service';
import { lockGatePinInitiatives, revokeGateAccess } from '@/core/ticketing/gate-revoke';
import { inTransaction } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeTenant, recordAudit, ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { requireSigner } from './kyb.service';
import { canonicalInbox, findOrCreateInvitee, queueHandoverNotice, sendSeatInvitation, storedInbox, TeamRejectedError, type TeamContext } from './team-common';

/**
 * El equipo que firma en los ajustes de la entidad (Sprint 4.2e): quién ocupa cada puesto, la invitación de la cofirma si aún no la ha aceptado y el
 * relevo abierto. Y los cambios que decide la propia entidad (2026-11-12), sin visto bueno de nadie ni intervención del Super-Admin: el modo de firma (una
 * firma o dos), invitar a la cofirma mientras su puesto está vacío (solo quien dirige) y el cargo visible de cada persona (el suyo propio).
 *
 * Qué se enseña: de cada persona firmante, su nombre y su cargo; de la persona invitada, el nombre que escribió quien la invitó y su email a medias
 * (`ma•••@gmail.com`). Nunca el email ni el móvil de la otra persona firmante.
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
  displayName: string;
  /** Completo para quien da el visto bueno mientras decide; a medias para el resto. */
  email: string;
  roleLabel: string;
  expiresAt: string;
  expired: boolean;
  /** Lo propuso la propia persona que sale (ceder su puesto). */
  selfProposed: boolean;
  /** Solo quien lo propuso puede retirarlo: quien sale no tiene veto. */
  proposedByMe: boolean;
  /** Es mi puesto el que se releva. */
  outgoingIsMe: boolean;
}

export interface SignerTeamData {
  /** Cuántas firmas exige la entidad (la elige ella). */
  signatureMode: 'DOUBLE' | 'SINGLE';
  seats: SeatView[];
  pendingCosigner: { displayName: string; roleLabel: string | null; maskedEmail: string; expired: boolean } | null;
  handover: HandoverView | null;
  myRole: SeatRole | null;
  myRoleLabel: string | null;
}

export async function loadSignerTeam(db: KorumPrismaClient, actor: SessionActor, organizationId: string, now: Date = new Date()): Promise<SignerTeamData> {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'organization.team_view', targetType: 'Organization', targetId: organizationId });
  const myUserId = actor.kind === 'user' ? actor.userId : null;
  const [members, pending, handover, organization] = await Promise.all([
    db.organizationMember.findMany({
      where: { organizationId, role: { in: [...SIGNER_ROLES] }, user: { gdprAnonymizedAt: null } },
      select: { role: true, roleLabel: true, user: { select: { id: true, name: true, twoFactorEnabled: true } } }
    }),
    listPendingCosignerInvitations(db, organizationId),
    db.signerHandover.findFirst({ where: { organizationId, status: { in: ['AWAITING_CONSENT', 'INVITED'] } } }),
    db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { signatureMode: true } })
  ]);
  // Siempre «Dirección» y después «Cofirma», sea cual sea el orden del tipo en la base.
  const seats: SeatView[] = [...members].sort((a, b) => Number(a.role !== 'DIRECTOR') - Number(b.role !== 'DIRECTOR')).map((member) => ({ role: member.role as SeatRole, name: member.user.name, roleLabel: member.roleLabel, isMe: member.user.id === myUserId, ready: member.user.twoFactorEnabled }));
  const lastInvitation = pending.at(-1);
  const pendingUser = lastInvitation && !seats.some((seat) => seat.role === 'COSIGNER') ? await db.user.findFirst({ where: { id: lastInvitation.userId, gdprAnonymizedAt: null }, select: { email: true } }) : null;
  const incoming = handover ? await db.user.findUnique({ where: { id: handover.incomingUserId }, select: { email: true } }) : null;
  const mine = seats.find((seat) => seat.isMe) ?? null;

  return {
    signatureMode: organization.signatureMode,
    seats,
    pendingCosigner: lastInvitation && pendingUser ? { displayName: lastInvitation.displayName ?? '', roleLabel: lastInvitation.roleLabel, maskedEmail: maskEmail(pendingUser.email), expired: lastInvitation.expired } : null,
    handover:
      handover && incoming
        ? {
            id: handover.id,
            role: handover.role as SeatRole,
            displayName: handover.displayName,
            email: maskEmail(incoming.email),
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
    if ((await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { signatureMode: true } })).signatureMode === 'SINGLE') throw new TeamRejectedError('SINGLE_MODE');
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

/**
 * La entidad cambia cuántas firmas exige (decisión del promotor, 2026-11-12). Lo decide Dirección con el código reciente y una confirmación expresa, y el
 * cambio es **inmediato**: sin espera ni visto bueno de nadie, y sin el Super-Admin. Lo que queda es un aviso por email y el registro de auditoría.
 *
 * - **A firma única:** el puesto de Cofirma desaparece (se da de baja su fila; su cuenta sigue existiendo), se retiran su invitación, su relevo abierto, sus
 *   enlaces de firma y los códigos de portería, y se le avisa. A partir de ahora aprueba y libera fondos solo la firma de Dirección.
 * - **A doble firma:** el puesto de Cofirma queda vacío hasta que Dirección invite a la persona; mientras tanto no se aprueba nada (faltan las dos firmas).
 */
export async function changeSignatureMode(db: KorumPrismaClient, actor: SessionActor, organizationId: string, raw: unknown, context: Pick<TeamContext, 'dispatch' | 'secondFactorFresh' | 'now' | 'hmacSecret'>): Promise<{ mode: 'DOUBLE' | 'SINGLE' }> {
  const signer = await requireSigner(db, actor, organizationId, 'signer.signature_mode_change');
  if (!signer.memberships.some((membership) => membership.organizationId === organizationId && membership.role === 'DIRECTOR')) {
    await recordAudit(db, signer, { action: 'tenant.access_denied', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { reason: 'ROLE_NOT_ALLOWED', attempted: 'signer.signature_mode_change' } });
    throw new TenantAccessError('ROLE_NOT_ALLOWED');
  }
  if (!context.secondFactorFresh) throw new TeamRejectedError('REAUTH_REQUIRED');
  const parsed = signatureModeChangeSchema.safeParse(raw);
  if (!parsed.success) throw new TeamRejectedError('INVALID', invalidFields(parsed.error));
  const { mode } = parsed.data;
  const now = context.now ?? new Date();
  const queued: number[] = [];

  try {
    await inTransaction(db, async (tx) => {
      // Primero las iniciativas con PIN de portería y después la entidad: el orden del resto del código (auditoría de seguridad, N2). Solo si puede revocarse.
      if (mode === 'SINGLE') await lockGatePinInitiatives(tx, organizationId, now);
      await tx.organization.updateMany({ where: { id: organizationId }, data: { updatedAt: now } });
      const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { signatureMode: true } });
      // El cargo de quien cambia el modo, comprobado con la entidad bloqueada: una persona recién relevada ya no cambia nada.
      const director = await tx.organizationMember.findFirst({ where: { organizationId, role: 'DIRECTOR', userId: signer.userId }, select: { id: true } });
      if (!director) throw new TenantAccessError('ROLE_NOT_ALLOWED');
      if (organization.signatureMode === mode) throw new TeamRejectedError('ALREADY_IN_MODE');
      await tx.organization.update({ where: { id: organizationId }, data: { signatureMode: mode } });
      let removedCosigner: string | null = null;
      let cancelledHandovers = 0;
      let revokedInvitations = 0;
      let convertedIdeas = 0;
      if (mode === 'SINGLE') {
        // Las ideas que ya esperaban solo la firma de Dirección se convierten ya, **antes** de tocar los enlaces de firma de la Cofirma: quien firma bloquea primero la
        // idea y después su enlace, y aquí se hace en el mismo orden (auditoría de seguridad del 5.2, N1). Las liquidaciones, con la tarea diaria o al reintentar.
        convertedIdeas = (await convertReadyIdeas(tx, context.hmacSecret, organizationId, now)).length;
        // Se anulan primero los relevos abiertos y las invitaciones pendientes, con la entidad ya bloqueada.
        const open = await tx.signerHandover.findMany({ where: { organizationId, status: { in: ['AWAITING_CONSENT', 'INVITED'] } }, select: { id: true, incomingUserId: true } });
        for (const handover of open) {
          await revokeHandoverInvitation(tx, handover.incomingUserId, organizationId, handover.id);
          await tx.signerHandover.update({ where: { id: handover.id }, data: { status: 'CANCELLED', closedAt: now } });
        }
        cancelledHandovers = open.length;
        revokedInvitations = (await revokePendingCosignerInvitations(tx, organizationId)).length;
        // La Cofirma se lee DESPUÉS de anular invitaciones y relevos, con la entidad bloqueada: nadie puede haber aceptado entre medias.
        const cosigner = await tx.organizationMember.findFirst({ where: { organizationId, role: 'COSIGNER' }, select: { id: true, roleLabel: true, userId: true } });
        if (cosigner) {
          await tx.doubleCheckChallenge.updateMany({ where: { organizationId, signerUserId: cosigner.userId, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
          await tx.organizationMember.delete({ where: { id: cosigner.id } });
          // Quien sale no conserva el PIN ni las sesiones de portería que tuviera.
          await revokeGateAccess(tx, organizationId, now);
          removedCosigner = cosigner.userId;
          const id = await queueHandoverNotice(tx, { handoverId: `mode-single-${now.getTime()}`, organizationId, recipientUserId: cosigner.userId, stage: 'MODE_SINGLE', role: 'COSIGNER', roleLabel: cosigner.roleLabel ?? '' });
          if (id !== null) queued.push(id);
        }
      } else {
        // Una invitación de Cofirma de antes de la firma única no debe volver a valer sin que Dirección invite de nuevo.
        await revokePendingCosignerInvitations(tx, organizationId);
      }
      // A Dirección también se le avisa: si alguien le roba la sesión, la persona de verdad se entera.
      const notice = await queueHandoverNotice(tx, { handoverId: `mode-${mode.toLowerCase()}-${now.getTime()}`, organizationId, recipientUserId: signer.userId, stage: 'MODE_CHANGED', role: 'DIRECTOR', roleLabel: '', mode });
      if (notice !== null) queued.push(notice);
      await recordAudit(tx, signer, { action: 'signer.signature_mode_changed', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { from: organization.signatureMode, to: mode, removedCosignerUserId: removedCosigner, cancelledHandovers, revokedInvitations, convertedIdeas } }, { required: true });
    });
  } catch (error) {
    // Dentro de la transacción un rechazo lo deshace todo, también su registro: el acceso denegado se anota fuera.
    if (error instanceof TenantAccessError) await recordAudit(db, signer, { action: 'tenant.access_denied', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { reason: 'ROLE_NOT_ALLOWED', attempted: 'signer.signature_mode_change' } });
    throw error;
  }
  context.dispatch(queued);
  return { mode };
}
