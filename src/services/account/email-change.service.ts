import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { closePrivacyRequest, openPrivacyRequest } from '@/core/privacy/privacy-requests';
import { dataHmac, safeEqual } from '@/core/security/data-hmac';
import { InvalidEmailError, isDisposableEmail, normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import { assertVerifiedActor, revalidateActor, secondFactorIsFresh, type VerifiedAccountActor } from '@/core/security/verified-actor';
import { inTransaction, type Db } from '@/lib/db';
import { pendingAccessCodesWhere } from '@/lib/auth/access-codes';
import { queueAuthEmail, type DispatchEmails } from '@/lib/auth/auth-emails';
import { reserveAttempt } from '@/lib/rate-limit';
import { ACCOUNT_EMAIL_CHANGE_RULE, EMAIL_CHANGE_TARGET_FAILURE_RULE, EMAIL_CHANGE_TARGET_RULE } from '@/lib/rate-limit-rules';
import { writeAudit } from '@/services/audit/audit.service';
import { credentialSnapshot, EMAIL_REVERT_DAYS, EMAIL_REVERT_PREFIX, emailChangeBlockedUntil, emailRevertUrl, type StoredRevert } from './email-change-revert.service';
import { moveEmailLinks } from './email-change-transfer';

/**
 * Cambiar el email de una cuenta (RGPD art. 16, `L-053`, decisiones 88 y 89; Sprint 5.10b). Lo hace la propia persona en *Mi cuenta*, sin el Super-Admin:
 *
 * 1. Confirma que es ella: código al email de la cuenta (o, si firma por una entidad, el código de su app de verificación) en los últimos 10 minutos.
 * 2. Escribe el email nuevo y recibe en él un código de 6 dígitos (10 minutos, 5 intentos). Si el email nuevo ya tiene cuenta no se dice hasta que demuestra que
 *    controla esa bandeja: si no, KORUM serviría para averiguar quién tiene cuenta. Además de los topes por cuenta, hay topes por **email de destino** (su forma
 *    canónica, contando todas las cuentas): nadie puede probar códigos sin fin contra la bandeja de otra persona abriendo muchas cuentas.
 * 3. Con el código, en una transacción: el email de la cuenta cambia y **todo lo que colgaba del antiguo pasa al nuevo** (decisión 88, `email-change-transfer.ts`). Las
 *    demás sesiones se cierran, queda en la auditoría (sin ningún email) y en «Mis solicitudes» como rectificación atendida, y el email antiguo recibe un aviso con un
 *    enlace «No he sido yo» de un solo uso, válido 14 días, que lo devuelve todo al email anterior (`email-change-revert.service.ts`). **Mientras ese enlace vale, el
 *    email no se puede volver a cambiar** (auditoría de seguridad del 5.10b): una sesión robada no puede inutilizarlo con un segundo cambio.
 *
 * Quien ya no puede entrar en su email antiguo no puede cambiarlo: abre una cuenta nueva (decisión 89). El Super-Admin nunca cambia un email a mano.
 */

export const EMAIL_CHANGE_CODE_MINUTES = 10;
export const EMAIL_CHANGE_MAX_ATTEMPTS = 5;
const PREFIX = 'korum-email-change:';
const identifierOf = (userId: string) => `${PREFIX}${userId}`;

interface StoredChange {
  newEmail: string;
  newCanonical: string;
  codeHash: string;
  attempts: number;
}

export type EmailChangeRejection = 'INVALID_EMAIL' | 'DISPOSABLE_EMAIL' | 'SAME_EMAIL' | 'RATE_LIMITED' | 'SECOND_FACTOR_REQUIRED' | 'RECENTLY_CHANGED' | 'RECENTLY_REVERTED';
/** `until`: con `RECENTLY_CHANGED` o `RECENTLY_REVERTED` (tras usar «No he sido yo»), desde cuándo se podrá volver a cambiar (ISO). */
export type EmailChangeRequestOutcome = { status: 'CODE_SENT'; email: string; minutes: number } | { status: 'REJECTED'; reason: EmailChangeRejection; until?: string };

export type EmailChangeConfirmRejection = 'NO_PENDING' | 'EXPIRED' | 'INVALID_CODE' | 'TOO_MANY_ATTEMPTS' | 'EMAIL_TAKEN' | 'SECOND_FACTOR_REQUIRED' | 'RECENTLY_CHANGED' | 'RECENTLY_REVERTED';
export type EmailChangeConfirmOutcome = { status: 'CHANGED'; email: string } | { status: 'REJECTED'; reason: EmailChangeConfirmRejection; until?: string };

export interface EmailChangeDeps {
  /** `DATA_HMAC_SECRET`: huella del código, de los topes por destino y de la solicitud de rectificación. */
  hmacSecret: string;
  dispatch: DispatchEmails;
  /** URL pública de la web, para el enlace «No he sido yo» del aviso al email antiguo. */
  appUrl: string;
}

const codeHash = (secret: string, userId: string, code: string) => dataHmac(secret, 'email-change-code', `${userId}:${code}`);
const targetKey = (secret: string, canonical: string) => dataHmac(secret, 'email-change-target', canonical);

/** Quien firma por una entidad (cuenta con verificación en dos pasos) confirma con la app de verificación, no con un código al email: su email abre su panel. */
async function proofMissing(db: Db, actor: VerifiedAccountActor): Promise<boolean> {
  const user = await db.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { twoFactorEnabled: true } });
  return user.twoFactorEnabled && !(await secondFactorIsFresh(db, { userId: actor.userId, sessionId: actor.sessionId }));
}

/** Paso 2: valida el email nuevo y le envía el código. Un código anterior sin usar deja de valer. */
export async function requestEmailChange(db: Db, deps: EmailChangeDeps, input: { actor: VerifiedAccountActor; newEmail: string }, now: Date = new Date()): Promise<EmailChangeRequestOutcome> {
  assertVerifiedActor(input.actor, 'verified-account', 'account.email_change', now);
  await revalidateActor(db, input.actor, 'account.email_change', now);
  if (await proofMissing(db, input.actor)) return { status: 'REJECTED', reason: 'SECOND_FACTOR_REQUIRED' };
  const blocked = await emailChangeBlockedUntil(db, input.actor.userId, now);
  if (blocked) return { status: 'REJECTED', reason: blocked.afterRevert ? 'RECENTLY_REVERTED' : 'RECENTLY_CHANGED', until: blocked.until.toISOString() };
  const newEmail = input.newEmail.trim().toLowerCase();
  let newCanonical: string;
  try {
    newCanonical = normalizeCanonicalEmail(newEmail);
  } catch (error) {
    if (error instanceof InvalidEmailError) return { status: 'REJECTED', reason: 'INVALID_EMAIL' };
    throw error;
  }
  if (newEmail.length > 254) return { status: 'REJECTED', reason: 'INVALID_EMAIL' };
  if (isDisposableEmail(newCanonical)) return { status: 'REJECTED', reason: 'DISPOSABLE_EMAIL' };
  const user = await db.user.findUniqueOrThrow({ where: { id: input.actor.userId }, select: { email: true, locale: true } });
  if (user.email.toLowerCase() === newEmail) return { status: 'REJECTED', reason: 'SAME_EMAIL' };
  if (!(await reserveAttempt(db, `${ACCOUNT_EMAIL_CHANGE_RULE.prefix}${input.actor.userId}`, ACCOUNT_EMAIL_CHANGE_RULE, now))) return { status: 'REJECTED', reason: 'RATE_LIMITED' };
  if (!(await reserveAttempt(db, `${EMAIL_CHANGE_TARGET_RULE.prefix}${targetKey(deps.hmacSecret, newCanonical)}`, EMAIL_CHANGE_TARGET_RULE, now))) return { status: 'REJECTED', reason: 'RATE_LIMITED' };

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const stored: StoredChange = { newEmail, newCanonical, codeHash: codeHash(deps.hmacSecret, input.actor.userId, code), attempts: 0 };
  await inTransaction(db, async (tx) => {
    await tx.verification.deleteMany({ where: { identifier: identifierOf(input.actor.userId) } });
    await tx.verification.create({ data: { id: randomUUID(), identifier: identifierOf(input.actor.userId), value: JSON.stringify(stored), expiresAt: new Date(now.getTime() + EMAIL_CHANGE_CODE_MINUTES * 60_000) } });
  });
  // En el idioma de la cuenta: quien pide el cambio es su titular. El tope por destinatario también vale aquí.
  const sent = await queueAuthEmail({ db, hmacSecret: deps.hmacSecret, dispatch: deps.dispatch }, { template: 'account.emailChangeCode', to: newEmail, locale: user.locale, payload: { code, minutes: EMAIL_CHANGE_CODE_MINUTES } });
  if (!sent) {
    await db.verification.deleteMany({ where: { identifier: identifierOf(input.actor.userId) } });
    return { status: 'REJECTED', reason: 'RATE_LIMITED' };
  }
  await writeAudit(db, { actorType: 'USER', actorUserId: input.actor.userId, action: 'account.email_change_requested', targetType: 'User', targetId: input.actor.userId });
  return { status: 'CODE_SENT', email: newEmail, minutes: EMAIL_CHANGE_CODE_MINUTES };
}

/** Se agotaron los intentos (de esta cuenta o, entre todas, contra ese email de destino): el código deja de valer y queda como rastro de seguridad. */
async function lockOut(tx: Db, userId: string, verificationId: string): Promise<EmailChangeConfirmOutcome> {
  await tx.verification.delete({ where: { id: verificationId } });
  await writeAudit(tx, { actorType: 'USER', actorUserId: userId, action: 'account.email_change_locked', targetType: 'User', targetId: userId });
  return { status: 'REJECTED', reason: 'TOO_MANY_ATTEMPTS' };
}

/** Paso 3: comprueba el código y hace el cambio. */
export async function confirmEmailChange(db: Db, deps: EmailChangeDeps, input: { actor: VerifiedAccountActor; code: string }, now: Date = new Date()): Promise<EmailChangeConfirmOutcome> {
  assertVerifiedActor(input.actor, 'verified-account', 'account.email_change', now);
  await revalidateActor(db, input.actor, 'account.email_change', now);
  if (await proofMissing(db, input.actor)) return { status: 'REJECTED', reason: 'SECOND_FACTOR_REQUIRED' };
  const userId = input.actor.userId;
  const code = input.code.trim();
  const outcome = await inTransaction(db, async (tx): Promise<EmailChangeConfirmOutcome & { notice?: number }> => {
    // La cuenta se bloquea: dos confirmaciones a la vez no cambian el email dos veces.
    const user = await tx.user.update({ where: { id: userId }, data: { updatedAt: now }, select: { email: true, canonicalEmail: true, locale: true } });
    const blocked = await emailChangeBlockedUntil(tx, userId, now);
    if (blocked) return { status: 'REJECTED', reason: blocked.afterRevert ? 'RECENTLY_REVERTED' : 'RECENTLY_CHANGED', until: blocked.until.toISOString() };
    const row = await tx.verification.findFirst({ where: { identifier: identifierOf(userId) }, select: { id: true, value: true, expiresAt: true } });
    if (!row) return { status: 'REJECTED', reason: 'NO_PENDING' };
    if (row.expiresAt <= now) {
      await tx.verification.delete({ where: { id: row.id } });
      return { status: 'REJECTED', reason: 'EXPIRED' };
    }
    const stored = JSON.parse(row.value) as StoredChange;
    if (!/^\d{6}$/.test(code) || !safeEqual(codeHash(deps.hmacSecret, userId, code), stored.codeHash)) {
      const attempts = stored.attempts + 1;
      const targetOk = await reserveAttempt(tx, `${EMAIL_CHANGE_TARGET_FAILURE_RULE.prefix}${targetKey(deps.hmacSecret, stored.newCanonical)}`, EMAIL_CHANGE_TARGET_FAILURE_RULE, now);
      if (attempts >= EMAIL_CHANGE_MAX_ATTEMPTS || !targetOk) return lockOut(tx, userId, row.id);
      await tx.verification.update({ where: { id: row.id }, data: { value: JSON.stringify({ ...stored, attempts }) } });
      return { status: 'REJECTED', reason: 'INVALID_CODE' };
    }
    await tx.verification.delete({ where: { id: row.id } });
    // Ya controla la bandeja nueva: decirle que tiene otra cuenta no revela nada a nadie más.
    const taken = await tx.user.findFirst({ where: { id: { not: userId }, OR: [{ canonicalEmail: stored.newCanonical }, { email: stored.newEmail }] }, select: { id: true } });
    if (taken) return { status: 'REJECTED', reason: 'EMAIL_TAKEN' };

    // Foto de las credenciales antes del cambio: el «No he sido yo» quita lo que se añada o cambie después.
    const snapshot = await credentialSnapshot(tx, deps.hmacSecret, userId);
    const moved = await moveEmailLinks(tx, userId, { email: user.email, canonical: user.canonicalEmail }, { email: stored.newEmail, canonical: stored.newCanonical });
    await tx.user.update({ where: { id: userId }, data: { email: stored.newEmail, canonicalEmail: stored.newCanonical, emailVerified: true, emailVerifiedAt: now, inactivityNoticeAt: null } });
    // Códigos y enlaces de acceso pendientes del email antiguo, y las demás sesiones: quien tuviera el email antiguo ya no entra.
    await tx.verification.deleteMany({ where: pendingAccessCodesWhere([user.email, user.canonicalEmail]) });
    const sessions = await tx.session.deleteMany({ where: { userId, id: { not: input.actor.sessionId } } });
    const request = await openPrivacyRequest(tx, deps.hmacSecret, { actor: input.actor, type: 'RECTIFICATION', notes: 'email:autoservicio' }, now);
    await closePrivacyRequest(tx, request.id, { status: 'COMPLETED' }, { kind: 'self', actor: input.actor }, now);
    await writeAudit(tx, { actorType: 'USER', actorUserId: userId, action: 'account.email_changed', targetType: 'User', targetId: userId, metadata: { ...moved, sessionsClosed: sessions.count } });
    // «No he sido yo»: un enlace de un solo uso al email antiguo que lo deshace (decisión del promotor, auditoría de seguridad del 5.10b). Solo queda su huella.
    const secret = randomBytes(32).toString('base64url');
    const revertId = randomUUID();
    const expiresAt = new Date(now.getTime() + EMAIL_REVERT_DAYS * 86_400_000);
    const revert: StoredRevert = { secretHash: dataHmac(deps.hmacSecret, 'email-revert', secret), previousEmail: user.email, previousCanonical: user.canonicalEmail, newEmail: stored.newEmail, newCanonical: stored.newCanonical, changedAt: now.toISOString(), ...snapshot };
    // Solo puede quedar uno caducado: mientras uno vale, no hay cambio nuevo.
    await tx.verification.deleteMany({ where: { identifier: `${EMAIL_REVERT_PREFIX}${userId}` } });
    await tx.verification.create({ data: { id: revertId, identifier: `${EMAIL_REVERT_PREFIX}${userId}`, value: JSON.stringify(revert), expiresAt } });
    // El aviso al email antiguo sale siempre (sin el tope de los códigos): si no fue la persona, es como se entera y como lo deshace.
    const notice = await tx.outboxMessage.create({
      select: { id: true },
      data: {
        idempotencyKey: `account.emailChanged:${userId}:${now.getTime()}`,
        templateKey: 'account.emailChanged',
        locale: user.locale,
        toAddress: user.email,
        userId,
        payloadJson: { changedAt: now.toISOString(), revertUrl: emailRevertUrl(deps.appUrl, user.locale, `${revertId}.${secret}`), expiresAt: expiresAt.toISOString(), days: EMAIL_REVERT_DAYS },
        nextAttemptAt: now
      }
    });
    return { status: 'CHANGED', email: stored.newEmail, notice: notice.id };
  });
  if (outcome.status !== 'CHANGED') return outcome;
  if (outcome.notice !== undefined) deps.dispatch([outcome.notice]);
  return { status: 'CHANGED', email: outcome.email };
}

/**
 * El cambio pendiente de esta cuenta, para que la página vuelva al paso del código: el email nuevo (lo escribió la propia persona) y hasta cuándo vale; nunca el código.
 * Los caducados los borra la purga semanal de códigos (`purgeExpiredSessions`).
 */
export async function pendingEmailChange(db: Db, userId: string, now: Date = new Date()): Promise<{ email: string; expiresAt: Date } | null> {
  const row = await db.verification.findFirst({ where: { identifier: identifierOf(userId), expiresAt: { gt: now } }, select: { value: true, expiresAt: true } });
  if (!row) return null;
  const stored = JSON.parse(row.value) as StoredChange;
  return { email: stored.newEmail, expiresAt: row.expiresAt };
}
