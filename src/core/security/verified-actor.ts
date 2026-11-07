import type { Db } from '@/lib/db';
import { SuperadminRequiredError, type SuperadminDenial } from './superadmin-guard';

/**
 * Personas verificadas para operaciones sensibles (QA-SEC07, QA-PRIV01, QA-REG03).
 *
 * - **Dónde vive la prueba:** en la sesión (`Session.reauthenticatedAt` y `Session.secondFactorVerifiedAt`), escrita **solo** por
 *   `markSessionReauthenticated`, que llama la capa de sesión (Sprint 3.2) en el momento en que comprueba el enlace, el código, el TOTP o la
 *   llave de acceso. Quien pide la operación nunca declara cuándo se verificó: se lee de la base.
 * - `VerifiedSuperadminActor`: Super-Admin con 2FA cuya sesión superó el segundo factor hace menos de `REAUTH_WINDOW_MS`. Lo exigen los
 *   ajustes y secretos de la consola y la supresión de una cuenta a petición del Super-Admin.
 * - `VerifiedAccountActor`: titular de la cuenta, con email verificado y reautenticado hace menos de `REAUTH_WINDOW_MS`. Lo exigen
 *   exportar y suprimir los propios datos: un identificador de usuario suelto no basta (sin esto, una ruta que lo tomara de la petición
 *   permitiría exportar o borrar la cuenta de otra persona).
 * - **No se fabrican ni se alargan:** los servicios solo aceptan actores emitidos aquí (registro interno con su fecha límite, fuera del
 *   objeto), y `revalidateActor` vuelve a comprobar en la base, dentro de la operación, que la sesión sigue viva y el rol sigue vigente.
 */

export const REAUTH_WINDOW_MS = 10 * 60_000;

export interface VerifiedSuperadminActor {
  readonly kind: 'verified-superadmin';
  readonly userId: string;
  readonly sessionId: string;
}

export interface VerifiedAccountActor {
  readonly kind: 'verified-account';
  readonly userId: string;
  readonly sessionId: string;
}

type VerifiedActor = VerifiedSuperadminActor | VerifiedAccountActor;

/** Fecha límite (ms) de cada actor emitido. Fuera del objeto: nadie la puede cambiar. */
const deadlines = new WeakMap<VerifiedActor, number>();

/** La escribe la capa de sesión al verificar la identidad de la persona en esta sesión. `secondFactor` si fue TOTP o llave de acceso. */
export async function markSessionReauthenticated(db: Db, sessionId: string, proof: { secondFactor: boolean }, now: Date = new Date()): Promise<void> {
  await db.session.update({ where: { id: sessionId }, data: { reauthenticatedAt: now, ...(proof.secondFactor ? { secondFactorVerifiedAt: now } : {}) } });
}

interface SessionInput {
  userId: string;
  sessionId: string;
  /** Operación para la que se pide (queda en la auditoría si se deniega). */
  operation: string;
}

const fresh = (verifiedAt: Date | null | undefined, now: Date) => {
  if (!verifiedAt) return false;
  const elapsed = now.getTime() - verifiedAt.getTime();
  // Una fecha futura no es una verificación reciente: es un reloj mal puesto o un intento de alargar la ventana.
  return elapsed >= 0 && elapsed <= REAUTH_WINDOW_MS;
};

async function loadSession(db: Db, input: SessionInput) {
  const [user, session] = await Promise.all([
    db.user.findUnique({ where: { id: input.userId }, select: { isSuperadmin: true, twoFactorEnabled: true, emailVerified: true, gdprAnonymizedAt: true } }),
    db.session.findUnique({ where: { id: input.sessionId }, select: { userId: true, expiresAt: true, reauthenticatedAt: true, secondFactorVerifiedAt: true } })
  ]);
  return { user, session: session && session.userId === input.userId ? session : null };
}

async function deny(db: Db, input: SessionInput, userExists: boolean, reason: SuperadminDenial, targetType: string): Promise<never> {
  await db.auditLog.create({ data: { actorType: 'USER', actorUserId: userExists ? input.userId : null, action: 'tenant.access_denied', targetType, targetId: '*', metadataJson: { attempted: input.operation, reason } } });
  throw new SuperadminRequiredError(reason, input.operation);
}

function issue<T extends VerifiedActor>(actor: T, verifiedAt: Date): T {
  const frozen: T = Object.freeze(Object.assign({}, actor));
  deadlines.set(frozen, verifiedAt.getTime() + REAUTH_WINDOW_MS);
  return frozen;
}

/** Debe llamarse **fuera** de la transacción de la operación: el aviso de acceso denegado tiene que quedar aunque la operación se aborte. */
export async function verifySuperadminSession(db: Db, input: SessionInput, now: Date = new Date()): Promise<VerifiedSuperadminActor> {
  const { user, session } = await loadSession(db, input);
  const reason: SuperadminDenial | null =
    !user?.isSuperadmin || user.gdprAnonymizedAt !== null
      ? 'NOT_SUPERADMIN'
      : !user.twoFactorEnabled
        ? 'TWO_FACTOR_REQUIRED'
        : !session || session.expiresAt <= now
          ? 'SESSION_INVALID'
          : !fresh(session.secondFactorVerifiedAt, now)
            ? 'REAUTH_REQUIRED'
            : null;
  if (reason !== null) return deny(db, input, Boolean(user), reason, 'SuperadminSession');
  return issue({ kind: 'verified-superadmin', userId: input.userId, sessionId: input.sessionId }, session!.secondFactorVerifiedAt!);
}

/** Titular de la cuenta reautenticado, para exportar o suprimir sus propios datos. */
export async function verifyAccountSession(db: Db, input: SessionInput, now: Date = new Date()): Promise<VerifiedAccountActor> {
  const { user, session } = await loadSession(db, input);
  const latest = [session?.reauthenticatedAt, session?.secondFactorVerifiedAt].filter((date): date is Date => Boolean(date)).sort((a, b) => b.getTime() - a.getTime())[0];
  const reason: SuperadminDenial | null =
    !user || user.gdprAnonymizedAt !== null || !user.emailVerified ? 'SESSION_INVALID' : !session || session.expiresAt <= now ? 'SESSION_INVALID' : !fresh(latest, now) ? 'REAUTH_REQUIRED' : null;
  if (reason !== null) return deny(db, input, Boolean(user), reason, 'AccountSession');
  return issue({ kind: 'verified-account', userId: input.userId, sessionId: input.sessionId }, latest!);
}

/**
 * Solo para la interfaz de *Mi cuenta*: dice si esta sesión ya demostró la identidad hace menos de `REAUTH_WINDOW_MS`, para pedir el código por
 * email **antes** de intentar exportar o suprimir. No emite ningún actor ni escribe en la auditoría (preguntarlo no es un intento denegado);
 * la operación vuelve a comprobarlo todo con `verifyAccountSession`.
 */
export async function accountReauthIsFresh(db: Db, input: { userId: string; sessionId: string }, now: Date = new Date()): Promise<boolean> {
  const { user, session } = await loadSession(db, { ...input, operation: 'account.reauth_status' });
  if (!user || user.gdprAnonymizedAt !== null || !user.emailVerified || !session || session.expiresAt <= now) return false;
  return fresh(session.reauthenticatedAt, now) || fresh(session.secondFactorVerifiedAt, now);
}

/** Comprueba que el actor salió de este módulo y que su reautenticación sigue vigente. */
export function assertVerifiedActor(actor: VerifiedActor, kind: VerifiedActor['kind'], operation: string, now: Date = new Date()): void {
  const deadline = deadlines.get(actor);
  if (deadline === undefined || actor.kind !== kind) throw new SuperadminRequiredError('SESSION_INVALID', operation);
  if (now.getTime() > deadline) throw new SuperadminRequiredError('REAUTH_REQUIRED', operation);
}

export const assertVerifiedSuperadmin = (actor: VerifiedSuperadminActor, operation: string, now?: Date) => assertVerifiedActor(actor, 'verified-superadmin', operation, now);

/** Dentro de la transacción de la operación: la sesión no se ha cerrado y el rol sigue (un Super-Admin dado de baja hace 2 minutos ya no vale). */
export async function revalidateActor(db: Db, actor: VerifiedActor, operation: string, now: Date = new Date()): Promise<void> {
  assertVerifiedActor(actor, actor.kind, operation, now);
  const { user, session } = await loadSession(db, { userId: actor.userId, sessionId: actor.sessionId, operation });
  const stillValid = session !== null && session.expiresAt > now && user !== null && user.gdprAnonymizedAt === null && (actor.kind === 'verified-account' || (user.isSuperadmin && user.twoFactorEnabled));
  if (!stillValid) throw new SuperadminRequiredError('SESSION_INVALID', operation);
}
