import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { safeEqual } from '@/core/security/data-hmac';
import { inTransaction, type Db } from '@/lib/db';

/**
 * Invitaciones para la segunda persona firmante de una entidad y para el primer Super-Admin.
 *
 * - El token va en el fragmento del enlace (`/invitacion#t=…`), que el navegador no envía al servidor ni deja en registros o en el
 *   `Referer`; la página lo lee y lo quita de la barra de direcciones.
 * - En la base solo queda el SHA-256 del secreto (tabla `Verification`, identificador por persona y entidad). Caduca en 72 horas, sirve una
 *   vez (se consume con un borrado condicional) y pedir otra anula la anterior.
 * - **El cargo no existe hasta que se acepta** (auditoría del 3.2, I3): la persona invitada no pasa a ser `COSIGNER` de una entidad que no
 *   conoce por el mero hecho de que alguien escriba su email. Al aceptar se crea la membresía con el cargo guardado en la invitación.
 * - Sin contraseña todavía: aceptar fija la contraseña y verifica el email (la persona demuestra que controla esa bandeja). Con cuenta y
 *   contraseña: se acepta con su propia sesión iniciada. Nunca se cambia la contraseña de una cuenta que ya la tiene.
 */

export const INVITATION_HOURS = 72;
export type InvitationPurpose = 'COSIGNER' | 'SUPERADMIN';

const PREFIX = 'korum-invite:';
const identifierOf = (userId: string, organizationId: string | null) => `${PREFIX}${userId}:${organizationId ?? 'platform'}`;
const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');

interface StoredInvitation {
  purpose: InvitationPurpose;
  secretHash: string;
  userId: string;
  organizationId: string | null;
  /** Cargo visible que tendrá la persona al aceptar (solo `COSIGNER`). */
  roleLabel: string | null;
  /**
   * Nombre que escribió quien la invitó. El panel muestra este y nunca `User.name`: si el email ya tenía cuenta, enseñar su nombre real a
   * quien solo sabe su email revelaría datos de una persona ajena (auditoría del 3.2, I4).
   */
  displayName: string | null;
}

export interface InvitationInput {
  userId: string;
  organizationId: string | null;
  purpose: InvitationPurpose;
  roleLabel?: string | null;
  displayName?: string | null;
}

/** Crea la invitación (anulando las anteriores de esa persona y entidad) y devuelve el token para el enlace. */
export async function createInvitation(db: Db, input: InvitationInput, now: Date = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + INVITATION_HOURS * 3_600_000);
  const stored: StoredInvitation = { purpose: input.purpose, secretHash: digest(secret), userId: input.userId, organizationId: input.organizationId, roleLabel: input.roleLabel ?? null, displayName: input.displayName ?? null };
  await inTransaction(db, async (tx) => {
    await tx.verification.deleteMany({ where: { identifier: identifierOf(input.userId, input.organizationId) } });
    await tx.verification.create({ data: { id, identifier: identifierOf(input.userId, input.organizationId), value: JSON.stringify(stored), expiresAt } });
  });
  return { token: `${id}.${secret}`, expiresAt };
}

/** Enlace de la invitación en el idioma de la persona. */
export const invitationUrl = (appUrl: string, locale: string, token: string) => `${appUrl.replace(/\/+$/, '')}${locale === 'es' ? '' : `/${locale}`}/invitacion#t=${token}`;

/** Invitaciones de cofirmante de una entidad aún sin aceptar (también las caducadas: se pueden reenviar). Sin el secreto. */
export async function listPendingCosignerInvitations(db: Db, organizationId: string): Promise<Array<{ userId: string; roleLabel: string | null; displayName: string | null; expired: boolean }>> {
  const rows = await db.verification.findMany({ where: { identifier: { startsWith: PREFIX, endsWith: `:${organizationId}` } }, select: { value: true, expiresAt: true }, orderBy: { createdAt: 'asc' } });
  const now = Date.now();
  return rows
    .map((row) => ({ stored: JSON.parse(row.value) as StoredInvitation, expiresAt: row.expiresAt }))
    .filter(({ stored }) => stored.purpose === 'COSIGNER' && stored.organizationId === organizationId)
    .map(({ stored, expiresAt }) => ({ userId: stored.userId, roleLabel: stored.roleLabel, displayName: stored.displayName ?? null, expired: expiresAt.getTime() <= now }));
}

async function findInvitation(db: Db, token: string, now: Date): Promise<(StoredInvitation & { id: string }) | null> {
  const [id, secret] = token.split('.');
  if (!id || !secret || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const row = await db.verification.findUnique({ where: { id } });
  if (!row || !row.identifier.startsWith(PREFIX) || row.expiresAt <= now) return null;
  const stored = JSON.parse(row.value) as StoredInvitation;
  return safeEqual(stored.secretHash, digest(secret)) ? { ...stored, id } : null;
}

const hasPasswordOf = async (db: Db, userId: string) => (await db.account.count({ where: { userId, providerId: 'credential', password: { not: null } } })) > 0;

export interface InvitationView {
  purpose: InvitationPurpose;
  email: string;
  organizationName: string | null;
  organizationSlug: string | null;
  roleLabel: string | null;
  /** La cuenta ya tiene contraseña: se acepta iniciando sesión con ella. */
  hasPassword: boolean;
}

/** Lo que muestra la página antes de aceptar. `null` si el enlace no existe, caducó o ya se usó (no se distingue). */
export async function inspectInvitation(db: Db, token: string, now: Date = new Date()): Promise<(InvitationView & { userId: string }) | null> {
  const invitation = await findInvitation(db, token, now);
  if (!invitation) return null;
  const user = await db.user.findUnique({ where: { id: invitation.userId }, select: { email: true, gdprAnonymizedAt: true, isSuperadmin: true } });
  if (!user || user.gdprAnonymizedAt) return null;
  const organization = invitation.organizationId ? await db.organization.findFirst({ where: { id: invitation.organizationId, archivedAt: null }, select: { name: true, slug: true } }) : null;
  if (invitation.purpose === 'COSIGNER' && (!organization || user.isSuperadmin)) return null;
  return {
    userId: invitation.userId,
    purpose: invitation.purpose,
    email: user.email,
    organizationName: organization?.name ?? null,
    organizationSlug: organization?.slug ?? null,
    roleLabel: invitation.roleLabel,
    hasPassword: await hasPasswordOf(db, invitation.userId)
  };
}

export class InvitationError extends Error {
  constructor(readonly reason: 'INVALID_LINK' | 'HAS_PASSWORD' | 'WEAK_PASSWORD' | 'WRONG_ACCOUNT') {
    super(`No se puede aceptar la invitación: ${reason}.`);
    this.name = 'InvitationError';
  }
}

/** Dentro de la transacción: consume el enlace, crea el cargo si es de una entidad y lo deja en la auditoría. */
async function consume(tx: Db, invitation: StoredInvitation & { id: string }, now: Date): Promise<void> {
  // Consumir antes de escribir nada: dos envíos simultáneos del mismo enlace no hacen dos veces el trabajo.
  const consumed = await tx.verification.deleteMany({ where: { id: invitation.id, expiresAt: { gt: now } } });
  if (consumed.count !== 1) throw new InvitationError('INVALID_LINK');
  if (invitation.purpose === 'COSIGNER' && invitation.organizationId) {
    await tx.organizationMember.createMany({ data: [{ organizationId: invitation.organizationId, userId: invitation.userId, role: 'COSIGNER', roleLabel: invitation.roleLabel }], skipDuplicates: true });
  }
  await tx.auditLog.create({
    data: { actorType: 'USER', actorUserId: invitation.userId, organizationId: invitation.organizationId, action: 'account.invitation_accepted', targetType: 'User', targetId: invitation.userId, metadataJson: { purpose: invitation.purpose } }
  });
}

/** Cuenta sin contraseña: fija la contraseña, verifica el email y acepta el cargo. Devuelve el email para iniciar sesión a continuación. */
export async function acceptInvitation(db: Db, token: string, password: string, now: Date = new Date()): Promise<{ email: string; userId: string }> {
  if (password.length < 12 || password.length > 128) throw new InvitationError('WEAK_PASSWORD');
  const view = await inspectInvitation(db, token, now);
  const invitation = view ? await findInvitation(db, token, now) : null;
  if (!view || !invitation) throw new InvitationError('INVALID_LINK');
  if (view.hasPassword) throw new InvitationError('HAS_PASSWORD');
  const passwordHash = await hashPassword(password);
  await inTransaction(db, async (tx) => {
    // Se vuelve a comprobar dentro: entre la lectura y aquí la cuenta podría haber recibido una contraseña.
    if (await hasPasswordOf(tx, invitation.userId)) throw new InvitationError('HAS_PASSWORD');
    await consume(tx, invitation, now);
    await tx.account.deleteMany({ where: { userId: invitation.userId, providerId: 'credential' } });
    await tx.account.create({ data: { id: randomUUID(), userId: invitation.userId, accountId: invitation.userId, providerId: 'credential', password: passwordHash } });
    await tx.user.update({ where: { id: invitation.userId }, data: { emailVerified: true, emailVerifiedAt: now } });
  });
  return { email: view.email, userId: invitation.userId };
}

/** Cuenta que ya tiene contraseña: acepta el cargo con la sesión de esa misma persona (de la cookie, nunca del formulario). */
export async function acceptInvitationWithSession(db: Db, token: string, sessionUserId: string, now: Date = new Date()): Promise<{ organizationSlug: string | null }> {
  const view = await inspectInvitation(db, token, now);
  const invitation = view ? await findInvitation(db, token, now) : null;
  if (!view || !invitation) throw new InvitationError('INVALID_LINK');
  if (view.userId !== sessionUserId) throw new InvitationError('WRONG_ACCOUNT');
  await inTransaction(db, (tx) => consume(tx, invitation, now));
  return { organizationSlug: view.organizationSlug };
}
