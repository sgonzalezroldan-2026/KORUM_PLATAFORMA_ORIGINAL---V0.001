import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { createInvitation, INVITATION_HOURS, invitationUrl, revokeSuperadminInvitation } from '@/core/onboarding/invitations';
import { InvalidEmailError, isDisposableEmail, normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import { assertVerifiedSuperadmin, revalidateActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import type { Locale } from '@/generated/prisma/enums';
import { queueAuthEmail, type DispatchEmails } from '@/lib/auth/auth-emails';
import { inTransaction, type Db } from '@/lib/db';
import { reserveAttempt } from '@/lib/rate-limit';
import { SUPERADMIN_INVITE_RULE } from '@/lib/rate-limit-rules';
import { coarseUserAgent, type RequestMeta } from '@/repositories/tenant-guard';
import { writeAudit } from '@/services/audit/audit.service';

/**
 * Equipo de Super-Admin (Sprint 5.4, `/admin/ajustes#equipo`): invitar a una persona, anular una invitación y retirar el acceso. Es lo más sensible de la consola (el rol lo ve y lo
 * cambia todo), así que:
 * - **El rol se da al aceptar**, no al invitar (`consume` de las invitaciones): una dirección mal escrita no deja un Super-Admin esperando. La invitación sirve una vez y caduca en 72 h.
 * - **Nunca a una cuenta que firma por una entidad** (la doble firma excluye siempre al Super-Admin): se rechaza al invitar y se vuelve a comprobar al aceptar.
 * - **Siempre queda alguien con acceso:** no se puede retirar a la última persona con el segundo factor activado ni retirarse a uno mismo. Las operaciones del equipo se ordenan con
 *   un bloqueo común (consultivo de PostgreSQL), así que dos Super-Admin que se retiran el acceso a la vez no pueden dejar la consola vacía.
 * - Retirar el acceso cierra **todas sus sesiones** al momento. Todo deja su rastro (sin el email de la persona).
 */

export type SuperadminTeamReason = 'INVALID_EMAIL' | 'ALREADY_SUPERADMIN' | 'ENTITY_MEMBER' | 'RATE_LIMITED' | 'SELF' | 'LAST_ADMIN' | 'NOT_FOUND' | 'INVALID_INPUT';

export class SuperadminTeamError extends Error {
  constructor(readonly reason: SuperadminTeamReason) {
    super(`Equipo de Super-Admin: ${reason}`);
    this.name = 'SuperadminTeamError';
  }
}

const auditOf = (meta?: RequestMeta) => ({ ipHash: meta?.ipHash ?? null, userAgent: coarseUserAgent(meta?.userAgent) });

const invitePayload = z.object({ email: z.string().trim().min(3).max(254), locale: z.enum(['es', 'ca', 'en']) });
const targetPayload = z.object({ userId: z.string().trim().min(1).max(80) });

export interface InviteDeps {
  appUrl: string;
  hmacSecret: string;
  /** Envía ya los emails escritos en la bandeja (en la aplicación, con `after()`). */
  dispatch: DispatchEmails;
}

/**
 * Bloqueo consultivo de la transacción: todas las operaciones del equipo pasan por aquí una a una y se liberan solas al confirmar o deshacer. Ninguna otra parte de la aplicación lo toma,
 * así que no puede bloquearse en cruz con el resto de la consola (a diferencia de una fila compartida, no depende de que exista).
 */
const lockTeam = async (tx: Db): Promise<void> => {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('korum:superadmin-team'))::text`;
};

export async function inviteSuperadmin(db: Db, actor: VerifiedSuperadminActor, raw: unknown, deps: InviteDeps, meta?: RequestMeta, now: Date = new Date()): Promise<void> {
  assertVerifiedSuperadmin(actor, 'superadmin.invite', now);
  const payload = invitePayload.safeParse(raw);
  if (!payload.success) throw new SuperadminTeamError('INVALID_INPUT');
  let canonicalEmail: string;
  try {
    canonicalEmail = normalizeCanonicalEmail(payload.data.email);
  } catch (error) {
    if (error instanceof InvalidEmailError) throw new SuperadminTeamError('INVALID_EMAIL');
    throw error;
  }
  if (isDisposableEmail(canonicalEmail)) throw new SuperadminTeamError('INVALID_EMAIL');
  const email = payload.data.email.trim().toLowerCase();
  const queued: number[] = [];

  await inTransaction(db, async (tx) => {
    // Primero el bloqueo común y después la comprobación de quien actúa: si mientras esperaba su turno le retiraron el acceso, ya no puede seguir.
    await lockTeam(tx);
    await revalidateActor(tx, actor, 'superadmin.invite', now);
    const existing = await tx.user.findUnique({ where: { canonicalEmail }, select: { id: true, email: true, locale: true, isSuperadmin: true, gdprAnonymizedAt: true } });
    if (existing?.gdprAnonymizedAt) throw new SuperadminTeamError('INVALID_EMAIL');
    if (existing?.isSuperadmin) throw new SuperadminTeamError('ALREADY_SUPERADMIN');
    if (existing && (await tx.organizationMember.count({ where: { userId: existing.id, role: { in: [...SIGNER_ROLES] } } })) > 0) throw new SuperadminTeamError('ENTITY_MEMBER');
    if (!(await reserveAttempt(tx, `${SUPERADMIN_INVITE_RULE.prefix}global`, SUPERADMIN_INVITE_RULE, now))) throw new SuperadminTeamError('RATE_LIMITED');

    const user = existing ?? (await tx.user.create({ data: { id: randomUUID(), email, canonicalEmail, locale: payload.data.locale satisfies Locale }, select: { id: true, email: true, locale: true, isSuperadmin: true, gdprAnonymizedAt: true } }));
    const { token } = await createInvitation(tx, { userId: user.id, organizationId: null, purpose: 'SUPERADMIN' }, now);
    const sent = await queueAuthEmail(
      { db: tx, hmacSecret: deps.hmacSecret, dispatch: (ids) => queued.push(...ids) },
      // Siempre a la dirección **de la cuenta**: el email se busca por su forma canónica (sin alias `+…`), así que lo tecleado puede ser otro buzón que el de la cuenta que recibirá el rol, y
      // quien abriera ese enlace fijaría la contraseña de una cuenta ajena y se quedaría con ella.
      { template: 'auth.invitation', to: existing?.email ?? email, locale: user.locale, payload: { url: invitationUrl(deps.appUrl, user.locale, token), hours: INVITATION_HOURS, organizationName: null, roleLabel: null } }
    );
    if (!sent) throw new SuperadminTeamError('RATE_LIMITED');
    await writeAudit(tx, { actorType: 'USER', actorUserId: actor.userId, ...auditOf(meta), action: 'superadmin.invited', targetType: 'User', targetId: user.id, metadata: { newAccount: existing === null } });
  });
  deps.dispatch(queued);
}

export async function cancelSuperadminInvitation(db: Db, actor: VerifiedSuperadminActor, raw: unknown, meta?: RequestMeta, now: Date = new Date()): Promise<void> {
  assertVerifiedSuperadmin(actor, 'superadmin.invitation_cancel', now);
  const payload = targetPayload.safeParse(raw);
  if (!payload.success) throw new SuperadminTeamError('INVALID_INPUT');
  await inTransaction(db, async (tx) => {
    await lockTeam(tx);
    await revalidateActor(tx, actor, 'superadmin.invitation_cancel', now);
    // Mismo orden que aceptar la invitación (cuenta → enlace): anular y aceptar a la vez se ordenan en lugar de bloquearse en cruz.
    await tx.user.updateMany({ where: { id: payload.data.userId }, data: { updatedAt: now } });
    if ((await revokeSuperadminInvitation(tx, payload.data.userId)) === 0) throw new SuperadminTeamError('NOT_FOUND');
    // Una cuenta que **creó esta invitación** (consta en su auditoría) y no se ha usado para nada más no se deja huérfana guardando un email ajeno durante años. Mismo criterio que la purga de
    // invitados sin activar (`purgeUnactivatedInvitees`): sin contraseña ni email verificado, sin sesiones, cargos, aportaciones, consentimientos, solicitudes, suscripciones ni tarjetas, y sin relevo
    // pendiente hacia ella. Se borra con ese mismo filtro (si algo cambió entre medias, no se borra nada).
    const createdHere = await tx.auditLog.count({ where: { action: 'superadmin.invited', targetId: payload.data.userId, metadataJson: { path: ['newAccount'], equals: true } } });
    const pendingHandover = await tx.signerHandover.count({ where: { incomingUserId: payload.data.userId, status: { in: ['AWAITING_CONSENT', 'INVITED'] } } });
    if (createdHere > 0 && pendingHandover === 0 && (await tx.verification.count({ where: { identifier: { startsWith: `korum-invite:${payload.data.userId}:` } } })) === 0) {
      await tx.user.deleteMany({
        where: {
          id: payload.data.userId,
          emailVerified: false,
          isSuperadmin: false,
          gdprAnonymizedAt: null,
          accounts: { none: {} },
          sessions: { none: {} },
          memberships: { none: {} },
          contributions: { none: {} },
          consentRecords: { none: {} },
          privacyRequests: { none: {} },
          walletSubscriptions: { none: {} },
          paymentMethodTokens: { none: {} },
          // Las claves foráneas que impiden borrar (si alguna llegara a existir, la cuenta no se borra y la anulación sigue su curso).
          walletTransactions: { none: {} },
          escrowLedgerEntries: { none: {} },
          doubleCheckSignatures: { none: {} },
          doubleCheckChallenges: { none: {} },
          activityFundPayouts: { none: {} }
        }
      });
    }
    await writeAudit(tx, { actorType: 'USER', actorUserId: actor.userId, ...auditOf(meta), action: 'superadmin.invitation_cancelled', targetType: 'User', targetId: payload.data.userId });
  });
}

/** Retira el acceso de un Super-Admin: pierde el rol y todas sus sesiones al momento. */
export async function revokeSuperadmin(db: Db, actor: VerifiedSuperadminActor, raw: unknown, meta?: RequestMeta, now: Date = new Date()): Promise<void> {
  assertVerifiedSuperadmin(actor, 'superadmin.revoke', now);
  const payload = targetPayload.safeParse(raw);
  if (!payload.success) throw new SuperadminTeamError('INVALID_INPUT');
  const { userId } = payload.data;
  if (userId === actor.userId) throw new SuperadminTeamError('SELF');
  await inTransaction(db, async (tx) => {
    await lockTeam(tx);
    await revalidateActor(tx, actor, 'superadmin.revoke', now);
    const target = await tx.user.findFirst({ where: { id: userId, isSuperadmin: true, gdprAnonymizedAt: null }, select: { id: true } });
    if (!target) throw new SuperadminTeamError('NOT_FOUND');
    // Tras retirarlo tiene que quedar alguien que pueda entrar (con el segundo factor activado: sin él la consola no se abre). Con quien actúa ya verificado y distinto del retirado siempre
    // se cumple; se comprueba igualmente para que ningún cambio futuro (otra vía de retirada, otro tipo de actor) pueda dejar la consola vacía.
    const remaining = await tx.user.count({ where: { isSuperadmin: true, twoFactorEnabled: true, gdprAnonymizedAt: null, id: { not: userId } } });
    if (remaining === 0) throw new SuperadminTeamError('LAST_ADMIN');
    await tx.user.update({ where: { id: userId }, data: { isSuperadmin: false } });
    // Su invitación pendiente (si no llegó a aceptarla) tampoco vale: si no, la aceptaría con su contraseña y recuperaría el rol.
    await revokeSuperadminInvitation(tx, userId);
    const { count } = await tx.session.deleteMany({ where: { userId } });
    await writeAudit(tx, { actorType: 'USER', actorUserId: actor.userId, ...auditOf(meta), action: 'superadmin.revoked', targetType: 'User', targetId: userId, metadata: { sessionsClosed: count } });
  });
}
