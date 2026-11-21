import { randomUUID } from 'node:crypto';
import { deleteUnverifiedSignup } from '@/core/privacy/retention-cleanup';
import { dataHmac, safeEqual } from '@/core/security/data-hmac';
import { inTransaction, type Db } from '@/lib/db';
import { pendingAccessCodesWhere } from '@/lib/auth/access-codes';
import { writeAudit } from '@/services/audit/audit.service';
import { moveEmailLinks } from './email-change-transfer';

/**
 * «No he sido yo» (Sprint 5.10b, decisión del promotor tras la auditoría de seguridad): el aviso que recibe el email antiguo al cambiar el email de una cuenta lleva un
 * enlace de un solo uso, válido 14 días, que **lo deshace**. Sirve cuando alguien con una sesión robada cambió el email para quedarse con la cuenta: quien controla el
 * email antiguo la recupera sin el Super-Admin (decisión 89: nadie cambia un email a mano).
 *
 * - El token va en el fragmento del enlace (`/cuenta/recuperar-email#t=…`), que el navegador no envía al servidor ni deja en registros; en la base solo queda su HMAC.
 * - Mientras el enlace vale, y 14 días más después de usarlo, la cuenta no puede volver a cambiar de email (`emailChangeBlockedUntil`): un segundo cambio no lo puede
 *   inutilizar ni empezar otra vez el mismo ataque.
 * - Lo devuelve todo al email anterior (lo mismo que movió el cambio), **cierra todas las sesiones**, anula los códigos pendientes y **quita lo que se añadió o cambió
 *   desde el cambio** para poder volver a entrar: **todas las llaves de acceso** (una llave añadida con la sesión robada puede ser anterior al cambio; la persona vuelve
 *   a añadir las suyas), una contraseña puesta o cambiada y una verificación en dos pasos activada o cambiada (se comparan con la foto que se guardó al cambiar). Si el
 *   email anterior lo ocupó una cuenta sin verificar (un alta, o la que crea un relevo o una invitación hacia él), se borra con lo que cuelga de ella; si lo tiene una
 *   cuenta verificada, no se puede devolver.
 * - Queda en la auditoría como rastro de seguridad, sin ningún email.
 */

export const EMAIL_REVERT_DAYS = 14;
export const EMAIL_REVERT_PREFIX = 'korum-email-revert:';
/** Tras deshacer un cambio, el email sigue sin poder cambiarse estos mismos 14 días (una marca en `Verification`, que borra la purga al caducar). */
const EMAIL_LOCK_PREFIX = 'korum-email-lock:';

export interface CredentialSnapshot {
  passkeyIds: string[];
  /** HMAC de la contraseña guardada (su huella), o `null` si no tenía. Nunca la huella misma. */
  passwordMark: string | null;
  /** HMAC del secreto de la verificación en dos pasos, o `null` si no la tenía activada. */
  twoFactorMark: string | null;
}

export interface StoredRevert extends CredentialSnapshot {
  secretHash: string;
  previousEmail: string;
  previousCanonical: string;
  newEmail: string;
  newCanonical: string;
  changedAt: string;
}

/** Enlace en el idioma de la persona, con el token en el fragmento. */
export const emailRevertUrl = (appUrl: string, locale: string, token: string) => `${appUrl.replace(/\/+$/, '')}${locale === 'es' ? '' : `/${locale}`}/cuenta/recuperar-email#t=${token}`;

/** Foto de las credenciales de la cuenta al cambiar el email (dentro de la transacción del cambio). */
export async function credentialSnapshot(tx: Db, hmacSecret: string, userId: string): Promise<CredentialSnapshot> {
  const [passkeys, credential, user, twoFactor] = await Promise.all([
    tx.passkey.findMany({ where: { userId }, select: { id: true } }),
    tx.account.findFirst({ where: { userId, providerId: 'credential' }, select: { password: true } }),
    tx.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorEnabled: true } }),
    tx.twoFactor.findFirst({ where: { userId }, select: { secret: true } })
  ]);
  return {
    passkeyIds: passkeys.map((row) => row.id),
    passwordMark: credential?.password ? dataHmac(hmacSecret, 'email-revert-password', credential.password) : null,
    twoFactorMark: user.twoFactorEnabled && twoFactor ? dataHmac(hmacSecret, 'email-revert-2fa', twoFactor.secret) : null
  };
}

/**
 * Hasta cuándo no se puede volver a cambiar el email de la cuenta, o `null`: mientras vale su enlace «No he sido yo» (`afterRevert: false`) o los 14 días siguientes a
 * usarlo (`afterRevert: true`; la página no remite entonces a un enlace que ya se gastó).
 */
export async function emailChangeBlockedUntil(db: Db, userId: string, now: Date = new Date()): Promise<{ until: Date; afterRevert: boolean } | null> {
  const row = await db.verification.findFirst({ where: { identifier: { in: [`${EMAIL_REVERT_PREFIX}${userId}`, `${EMAIL_LOCK_PREFIX}${userId}`] }, expiresAt: { gt: now } }, orderBy: { expiresAt: 'desc' }, select: { expiresAt: true, identifier: true } });
  return row ? { until: row.expiresAt, afterRevert: row.identifier.startsWith(EMAIL_LOCK_PREFIX) } : null;
}

export type RemovedCredentials = { passkeys: number; password: boolean; twoFactor: boolean };
export type EmailRevertOutcome = { status: 'REVERTED'; email: string; removed: RemovedCredentials } | { status: 'INVALID' | 'EXPIRED' | 'EMAIL_TAKEN' };

/** Quita lo que se añadió o cambió desde el cambio de email (comparado con la foto). */
async function removeNewCredentials(tx: Db, hmacSecret: string, userId: string, stored: StoredRevert): Promise<RemovedCredentials> {
  const passkeys = await tx.passkey.deleteMany({ where: { userId } });
  const now = await credentialSnapshot(tx, hmacSecret, userId);
  let password = false;
  if (now.passwordMark !== stored.passwordMark) {
    // Sin contraseña antes: fuera la que se creó. Con otra antes: se vacía y la persona la restablece con un código a su email.
    if (stored.passwordMark === null) await tx.account.deleteMany({ where: { userId, providerId: 'credential' } });
    else await tx.account.updateMany({ where: { userId, providerId: 'credential' }, data: { password: null } });
    password = true;
  }
  let twoFactor = false;
  if (now.twoFactorMark !== stored.twoFactorMark && now.twoFactorMark !== null) {
    await tx.twoFactor.deleteMany({ where: { userId } });
    await tx.user.update({ where: { id: userId }, data: { twoFactorEnabled: false } });
    twoFactor = true;
  }
  return { passkeys: passkeys.count, password, twoFactor };
}

export async function revertEmailChange(db: Db, deps: { hmacSecret: string }, input: { token: string }, now: Date = new Date()): Promise<EmailRevertOutcome> {
  const [id, secret] = input.token.trim().split('.');
  if (!id || !secret || !/^[0-9a-f-]{36}$/.test(id) || !/^[A-Za-z0-9_-]{20,100}$/.test(secret)) return { status: 'INVALID' };
  return inTransaction(db, async (tx): Promise<EmailRevertOutcome> => {
    const first = await tx.verification.findUnique({ where: { id }, select: { identifier: true } });
    if (!first || !first.identifier.startsWith(EMAIL_REVERT_PREFIX)) return { status: 'INVALID' };
    const userId = first.identifier.slice(EMAIL_REVERT_PREFIX.length);
    // Primero se bloquea la cuenta y después se vuelve a leer el enlace: dos clics a la vez esperan uno al otro y el segundo ya no lo encuentra.
    const locked = await tx.user.updateMany({ where: { id: userId, gdprAnonymizedAt: null }, data: { updatedAt: now } });
    const row = await tx.verification.findUnique({ where: { id }, select: { value: true, expiresAt: true } });
    if (!row) return { status: 'INVALID' };
    const stored = JSON.parse(row.value) as StoredRevert;
    if (!safeEqual(dataHmac(deps.hmacSecret, 'email-revert', secret), stored.secretHash)) return { status: 'INVALID' };
    if (locked.count === 0) {
      await tx.verification.deleteMany({ where: { id } });
      return { status: 'INVALID' };
    }
    if (row.expiresAt <= now) {
      await tx.verification.deleteMany({ where: { id } });
      return { status: 'EXPIRED' };
    }
    const current = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, canonicalEmail: true } });
    // El email anterior ocupado: por un alta sin verificar que nadie usó (alguien que no controla esa bandeja), se libera; por una cuenta verificada, no.
    const holder = await tx.user.findFirst({ where: { id: { not: userId }, OR: [{ canonicalEmail: stored.previousCanonical }, { email: stored.previousEmail }] }, select: { id: true, emailVerified: true } });
    if (holder && (holder.emailVerified || !(await deleteUnverifiedSignup(tx, holder.id, { cancelPending: true, now })))) return { status: 'EMAIL_TAKEN' };
    const moved = await moveEmailLinks(tx, userId, { email: current.email, canonical: current.canonicalEmail }, { email: stored.previousEmail, canonical: stored.previousCanonical });
    await tx.user.update({ where: { id: userId }, data: { email: stored.previousEmail, canonicalEmail: stored.previousCanonical, emailVerified: true, emailVerifiedAt: now } });
    const removed = await removeNewCredentials(tx, deps.hmacSecret, userId, stored);
    const sessions = await tx.session.deleteMany({ where: { userId } });
    await tx.verification.deleteMany({ where: { OR: [{ id }, { identifier: `korum-email-change:${userId}` }, { identifier: `${EMAIL_LOCK_PREFIX}${userId}` }, pendingAccessCodesWhere([current.email, current.canonicalEmail, stored.newEmail, stored.newCanonical])] } });
    await tx.verification.create({ data: { id: randomUUID(), identifier: `${EMAIL_LOCK_PREFIX}${userId}`, value: '{}', expiresAt: new Date(now.getTime() + EMAIL_REVERT_DAYS * 86_400_000) } });
    await writeAudit(tx, { actorType: 'USER', actorUserId: userId, action: 'account.email_change_reverted', targetType: 'User', targetId: userId, metadata: { ...moved, sessionsClosed: sessions.count, passkeysRemoved: removed.passkeys, passwordRemoved: removed.password, twoFactorRemoved: removed.twoFactor } });
    return { status: 'REVERTED', email: stored.previousEmail, removed };
  });
}
