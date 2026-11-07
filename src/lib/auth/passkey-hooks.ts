import { APIError, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { REAUTH_WINDOW_MS } from '@/core/security/verified-actor';
import type { Db } from '@/lib/db';
import { writeAudit } from '@/services/audit/audit.service';
import { queueAuthEmail, type AuthEmailDeps } from './auth-emails';

/**
 * Llaves de acceso (passkeys) y sesiones que se sustituyen (Sprint 3.7, auditoría de seguridad). Una llave abre sesiones con segundo factor y no
 * caduca con un cambio de contraseña, así que añadirla es tan delicado como activar el 2FA:
 *
 * - **Antes de registrar** (`guardPasskeyRegistration`): prueba de identidad de los últimos 10 minutos en esta sesión; el TOTP si la cuenta tiene
 *   2FA. Quien firma por una entidad o es Super-Admin y **aún no tiene 2FA** no puede añadir una llave: primero el TOTP (si no, se saltaría el
 *   2FA obligatorio con una llave registrada con el correo). El nombre se limita también en el servidor.
 * - **Después de registrar** (`recordPasskeyAdded`): queda en `AuditLog` y la persona recibe un email de seguridad.
 * - **Nueva sesión por una prueba de identidad** (`retirePreviousSession`): al confirmar con el código, el enlace o una llave estando ya dentro, la
 *   sesión anterior de esa misma persona se cierra: reautenticarse no deja sesiones de 30 días olvidadas.
 */

export const PASSKEY_REGISTRATION_PATHS: ReadonlySet<string> = new Set(['/passkey/generate-register-options', '/passkey/verify-registration']);
export const PASSKEY_NAME_MAX = 40;
/** Pruebas de identidad que crean una sesión nueva aunque ya hubiera una abierta en ese navegador. */
export const SESSION_REPLACING_PATHS: ReadonlySet<string> = new Set(['/sign-in/email-otp', '/magic-link/verify', '/passkey/verify-authentication']);

export interface PasskeyHookDeps {
  db: Db;
  now?: () => Date;
}

const blocked = (status: 'FORBIDDEN' | 'BAD_REQUEST', code: string) => new APIError(status, { code, message: code });

const freshProof = (date: Date | null | undefined, now: Date) => {
  if (!date) return false;
  const elapsed = now.getTime() - date.getTime();
  return elapsed >= 0 && elapsed <= REAUTH_WINDOW_MS;
};

type HookContext = Parameters<typeof getSessionFromCtx>[0];

export async function guardPasskeyRegistration(ctx: HookContext & { path?: string; body?: unknown }, deps: PasskeyHookDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  if (ctx.path === '/passkey/verify-registration') {
    const name = (ctx.body as { name?: unknown } | undefined)?.name;
    if (name !== undefined && name !== null && (typeof name !== 'string' || name.length > PASSKEY_NAME_MAX)) throw blocked('BAD_REQUEST', 'KORUM_PASSKEY_NAME_TOO_LONG');
  }
  const session = await getSessionFromCtx(ctx);
  // Sin sesión, el propio punto de Better Auth la rechaza.
  if (!session) return;
  const [user, row, signerRoles] = await Promise.all([
    deps.db.user.findUnique({ where: { id: session.user.id }, select: { twoFactorEnabled: true, isSuperadmin: true } }),
    deps.db.session.findUnique({ where: { id: session.session.id }, select: { reauthenticatedAt: true, secondFactorVerifiedAt: true } }),
    deps.db.organizationMember.count({ where: { userId: session.user.id, role: { in: [...SIGNER_ROLES] } } })
  ]);
  if (!user?.twoFactorEnabled && (user?.isSuperadmin || signerRoles > 0)) throw blocked('FORBIDDEN', 'KORUM_TWO_FACTOR_SETUP_REQUIRED');
  if (user?.twoFactorEnabled) {
    if (!freshProof(row?.secondFactorVerifiedAt, now)) throw blocked('FORBIDDEN', 'KORUM_SECOND_FACTOR_REQUIRED');
  } else if (!freshProof(row?.reauthenticatedAt, now) && !freshProof(row?.secondFactorVerifiedAt, now)) {
    throw blocked('FORBIDDEN', 'KORUM_REAUTH_REQUIRED');
  }
}

export async function recordPasskeyAdded(ctx: HookContext & { context: { returned?: unknown } }, deps: PasskeyHookDeps, emails: AuthEmailDeps): Promise<void> {
  if (isAPIError(ctx.context.returned)) return;
  const session = await getSessionFromCtx(ctx).catch(() => null);
  if (!session) return;
  const returned = ctx.context.returned as { id?: unknown } | null | undefined;
  await writeAudit(deps.db, { actorType: 'USER', actorUserId: session.user.id, action: 'account.passkey_added', targetType: 'Passkey', targetId: typeof returned?.id === 'string' ? returned.id : '*' });
  const user = await deps.db.user.findUnique({ where: { id: session.user.id }, select: { email: true, locale: true } });
  if (user) await queueAuthEmail(emails, { template: 'account.passkeyAdded', to: user.email, locale: user.locale, payload: {} });
}

/** La cookie de sesión que traía la petición, si es de la misma persona que acaba de demostrar su identidad, deja de valer. */
export async function retirePreviousSession(
  ctx: {
    getSignedCookie: (key: string, secret: string) => Promise<string | false | null>;
    context: { secret: string; authCookies: { sessionToken: { name: string } }; newSession?: { session: { token: string }; user: { id: string } } | null };
  },
  deps: PasskeyHookDeps
): Promise<void> {
  const fresh = ctx.context.newSession;
  if (!fresh) return;
  const previous = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
  if (!previous || previous === fresh.session.token) return;
  await deps.db.session.deleteMany({ where: { token: previous, userId: fresh.user.id } });
}
