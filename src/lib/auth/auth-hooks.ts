import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { InvalidEmailError, isDisposableEmail, normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import { markSessionReauthenticated, REAUTH_WINDOW_MS } from '@/core/security/verified-actor';
import type { Locale } from '@/generated/prisma/enums';
import type { Db } from '@/lib/db';
import { clearAttempts, countAttempts, lastAttemptAt, reserveAttempt } from '@/lib/rate-limit';
import { AUTH_REQUEST_PREFIX, AUTH_SECOND_FACTOR_FAILURE_RULE, AUTH_SECOND_FACTOR_RULE } from '@/lib/rate-limit-rules';
import { coarseUserAgent } from '@/repositories/tenant-guard';
import { hashAuditIp } from '@/services/audit/audit.service';
import { dataHmac } from '@/core/security/data-hmac';

/**
 * Ganchos de seguridad de Better Auth (Sprint 3.2). Todo lo que decide quién puede entrar y qué prueba deja cada inicio de sesión:
 *
 * - **Cuenta nueva:** se guarda su email canónico (`canonicalEmail`, regla anti-multicuenta); se rechazan los dominios desechables y una
 *   segunda cuenta con la misma bandeja (`laura+1@gmail.com` frente a `laura@gmail.com`).
 * - **Sesión nueva:** una cuenta suprimida (`gdprAnonymizedAt`) no entra; la IP se guarda solo como HMAC (`hashAuditIp`) y del navegador solo
 *   la familia (`Chrome/Windows`); se actualiza `User.lastActiveAt` (sin eso, la purga por inactividad tomaría por abandonada una cuenta en uso).
 * - **Prueba de identidad:** tras comprobar el enlace o el código por email se marca `reauthenticatedAt`; tras el TOTP o un código de
 *   respaldo, además `secondFactorVerifiedAt` (`markSessionReauthenticated`, que solo se llama desde aquí).
 */

const LOCALES: readonly Locale[] = ['es', 'ca', 'en'];

type HookContext = { request?: Request; headers?: Headers; body?: unknown; query?: unknown } | null | undefined;

/** Idioma de la persona al crear su cuenta: cabecera `x-korum-locale` del formulario o prefijo de la URL de vuelta (`/ca/...`). */
export function localeFromContext(context: HookContext): Locale {
  const header = context?.headers?.get('x-korum-locale') ?? context?.request?.headers.get('x-korum-locale');
  if (header && (LOCALES as readonly string[]).includes(header)) return header as Locale;
  const fromObject = (value: unknown) => (value && typeof value === 'object' && 'callbackURL' in value ? String((value as { callbackURL: unknown }).callbackURL ?? '') : '');
  const callback = fromObject(context?.query) || fromObject(context?.body);
  const prefix = /^\/(ca|en)(\/|$)/.exec(callback.startsWith('http') ? safePath(callback) : callback)?.[1];
  return (prefix as Locale | undefined) ?? 'es';
}

const safePath = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
};

/** Códigos de error propios (el formulario de acceso los traduce). */
export const AUTH_ERROR = {
  INVALID_EMAIL: 'KORUM_INVALID_EMAIL',
  DISPOSABLE_EMAIL: 'KORUM_DISPOSABLE_EMAIL',
  SAME_INBOX: 'KORUM_SAME_INBOX',
  ACCOUNT_CLOSED: 'KORUM_ACCOUNT_CLOSED'
} as const;

const reject = (status: 'BAD_REQUEST' | 'FORBIDDEN', code: string) => new APIError(status, { code, message: code });

/** Email canónico de una cuenta nueva, o el motivo por el que no se puede crear. */
export async function canonicalEmailForNewUser(db: Db, email: string): Promise<string> {
  let canonicalEmail: string;
  try {
    canonicalEmail = normalizeCanonicalEmail(email);
  } catch (error) {
    if (error instanceof InvalidEmailError) throw reject('BAD_REQUEST', AUTH_ERROR.INVALID_EMAIL);
    throw error;
  }
  if (isDisposableEmail(canonicalEmail)) throw reject('BAD_REQUEST', AUTH_ERROR.DISPOSABLE_EMAIL);
  // La persona ya demostró que controla esta bandeja (el enlace o el código llegaron a ella): decirle que ya tiene cuenta no revela nada a otros.
  if (await db.user.findUnique({ where: { canonicalEmail }, select: { id: true } })) throw reject('BAD_REQUEST', AUTH_ERROR.SAME_INBOX);
  return canonicalEmail;
}

export interface HookDeps {
  db: Db;
  hmacSecret: string;
  now?: () => Date;
}

export function buildDatabaseHooks(deps: HookDeps) {
  const now = () => deps.now?.() ?? new Date();
  return {
    user: {
      create: {
        before: async (user: { email: string; emailVerified?: boolean } & Record<string, unknown>, context: HookContext) => {
          const canonicalEmail = await canonicalEmailForNewUser(deps.db, user.email);
          return { data: { ...user, canonicalEmail, locale: localeFromContext(context), isSuperadmin: false, emailVerifiedAt: user.emailVerified ? now() : null } };
        }
      },
      update: {
        before: async (data: Record<string, unknown>) => (data.emailVerified === true ? { data: { ...data, emailVerifiedAt: now() } } : { data })
      }
    },
    session: {
      create: {
        before: async (session: { userId: string; ipAddress?: string | null; userAgent?: string | null } & Record<string, unknown>) => {
          const user = await deps.db.user.findUnique({ where: { id: session.userId }, select: { gdprAnonymizedAt: true } });
          if (!user || user.gdprAnonymizedAt) throw reject('FORBIDDEN', AUTH_ERROR.ACCOUNT_CLOSED);
          return {
            data: {
              ...session,
              // Al activar el TOTP, Better Auth copia la IP y el navegador de la sesión anterior, ya reducidos: no se vuelven a reducir.
              ipAddress: !session.ipAddress ? null : /^[0-9a-f]{64}$/.test(session.ipAddress) ? session.ipAddress : hashAuditIp(deps.hmacSecret, session.ipAddress),
              userAgent: session.userAgent && /^[A-Za-z]+\/[A-Za-z]+$/.test(session.userAgent) ? session.userAgent : coarseUserAgent(session.userAgent ?? undefined)
            }
          };
        },
        after: async (session: { userId: string }) => {
          await deps.db.user.update({ where: { id: session.userId }, data: { lastActiveAt: now() } });
        }
      }
    }
  };
}

/** Rutas de Better Auth que prueban la identidad de la persona, y con qué fuerza. */
export const IDENTITY_PROOF_PATHS: Readonly<Record<string, 'email' | 'second-factor'>> = {
  '/magic-link/verify': 'email',
  '/sign-in/email-otp': 'email',
  '/email-otp/verify-email': 'email',
  '/two-factor/verify-totp': 'second-factor',
  '/two-factor/verify-backup-code': 'second-factor'
};

/** Sesión que deja una prueba correcta: la recién creada o, si ya había sesión (reautenticación), la que devuelve la respuesta. */
async function provenSessionId(db: Db, context: { newSession?: { session: { id: string } } | null; returned?: unknown }): Promise<string | null> {
  if (context.newSession?.session.id) return context.newSession.session.id;
  if (isAPIError(context.returned)) return null;
  const token = context.returned && typeof context.returned === 'object' && 'token' in context.returned ? (context.returned as { token: unknown }).token : null;
  if (typeof token !== 'string' || token === '') return null;
  return (await db.session.findUnique({ where: { token }, select: { id: true } }))?.id ?? null;
}

const SECOND_FACTOR_PATHS = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code']);
const failureKey = (userId: string) => `${AUTH_SECOND_FACTOR_FAILURE_RULE.prefix}${userId}`;
const blocked = (status: 'FORBIDDEN' | 'TOO_MANY_REQUESTS' | 'BAD_REQUEST', code: string) => new APIError(status, { code, message: code });

/**
 * Antes de las rutas del doble factor (auditoría del 3.2, B1 e I1):
 * - **Cambiar el TOTP exige el TOTP.** Quien solo controla el correo puede restablecer la contraseña y abrir sesión con un enlace mágico; si
 *   con eso pudiera volver a activar el doble factor, se quedaría con un secreto nuevo. Por eso `/two-factor/enable` en una cuenta que ya lo
 *   tiene exige que **esta sesión** haya superado el segundo factor hace menos de 10 minutos, y solo con app (`method: 'totp'`). Las rutas
 *   que devuelven el secreto, generan códigos de respaldo o desactivan el 2FA están apagadas (`disabledPaths` en `auth-config.ts`).
 * - **Probar códigos con una sesión abierta tiene tope.** Better Auth solo bloquea la cuenta al entrar con contraseña. Aquí: 10 intentos por
 *   persona cada 15 minutos y, tras 8 fallos seguidos, bloqueo de 24 horas y cierre de sus sesiones sin segundo factor (gancho `after`).
 */
export function buildSecondFactorGuard(deps: HookDeps) {
  return createAuthMiddleware(async (ctx) => {
    const now = deps.now?.() ?? new Date();
    if (ctx.path === '/two-factor/enable') {
      if ((ctx.body as { method?: unknown } | undefined)?.method === 'otp') throw blocked('BAD_REQUEST', 'KORUM_TOTP_ONLY');
      const session = await getSessionFromCtx(ctx);
      if (!session) return;
      const [user, row] = await Promise.all([
        deps.db.user.findUnique({ where: { id: session.user.id }, select: { twoFactorEnabled: true } }),
        deps.db.session.findUnique({ where: { id: session.session.id }, select: { secondFactorVerifiedAt: true } })
      ]);
      const elapsed = row?.secondFactorVerifiedAt ? now.getTime() - row.secondFactorVerifiedAt.getTime() : null;
      const fresh = elapsed !== null && elapsed >= 0 && elapsed <= REAUTH_WINDOW_MS;
      if (user?.twoFactorEnabled && !fresh) throw blocked('FORBIDDEN', 'KORUM_SECOND_FACTOR_REQUIRED');
      return;
    }
    if (!ctx.path || !SECOND_FACTOR_PATHS.has(ctx.path)) return;
    const session = await getSessionFromCtx(ctx);
    if (!session) return;
    const last = await lastAttemptAt(deps.db, failureKey(session.user.id));
    const recent = last !== null && now.getTime() - last < AUTH_SECOND_FACTOR_FAILURE_RULE.windowMs;
    if (recent && (await countAttempts(deps.db, failureKey(session.user.id))) >= AUTH_SECOND_FACTOR_FAILURE_RULE.limit) throw blocked('TOO_MANY_REQUESTS', 'KORUM_SECOND_FACTOR_LOCKED');
    const allowed = await reserveAttempt(deps.db, `${AUTH_SECOND_FACTOR_RULE.prefix}${session.user.id}`, AUTH_SECOND_FACTOR_RULE, now);
    if (!allowed) throw blocked('TOO_MANY_REQUESTS', 'KORUM_SECOND_FACTOR_LIMIT');
  });
}

/** Tras un código con la sesión ya abierta: cuenta los fallos seguidos y, al llegar al tope, cierra las sesiones sin segundo factor. */
async function trackSessionSecondFactor(deps: HookDeps, context: { newSession?: { user: { id: string } } | null; returned?: unknown }, openSessionUserId: string | null): Promise<void> {
  const userId = context.newSession?.user.id ?? openSessionUserId;
  if (!userId) return;
  if (!isAPIError(context.returned)) return clearAttempts(deps.db, failureKey(userId));
  // Solo los fallos con una sesión abierta: al entrar con contraseña ya bloquea la cuenta Better Auth.
  if (!openSessionUserId) return;
  await reserveAttempt(deps.db, failureKey(userId), AUTH_SECOND_FACTOR_FAILURE_RULE, deps.now?.());
  if ((await countAttempts(deps.db, failureKey(userId))) >= AUTH_SECOND_FACTOR_FAILURE_RULE.limit) {
    await deps.db.session.deleteMany({ where: { userId, secondFactorVerifiedAt: null } });
  }
}

export function buildIdentityProofHook(deps: HookDeps) {
  return createAuthMiddleware(async (ctx) => {
    if (ctx.path && SECOND_FACTOR_PATHS.has(ctx.path)) await trackSessionSecondFactor(deps, ctx.context, (await getSessionFromCtx(ctx).catch(() => null))?.user.id ?? null);
    const proof = ctx.path ? IDENTITY_PROOF_PATHS[ctx.path] : undefined;
    if (!proof) return;
    const sessionId = await provenSessionId(deps.db, ctx.context);
    if (sessionId) await markSessionReauthenticated(deps.db, sessionId, { secondFactor: proof === 'second-factor' }, deps.now?.());
  });
}

/**
 * Almacén de los límites de Better Auth sobre `RateLimit`, con claves propias (`auth:ip:` + HMAC). El almacén de base de datos de Better
 * Auth no sirve: purga **todas** las filas más viejas que su ventana más larga, y borraría los contadores de la portería (15 minutos por IP
 * y sin caducidad por evento, QA-SEC06) y del resto de KORUM.
 */
export function buildRateLimitStorage(deps: HookDeps) {
  return {
    consume: async (key: string, rule: { window: number; max: number }) => {
      const storageKey = `${AUTH_REQUEST_PREFIX}${dataHmac(deps.hmacSecret, 'auth-rate-limit', key)}`;
      const windowMs = rule.window * 1000;
      const current = deps.now?.() ?? new Date();
      if (await reserveAttempt(deps.db, storageKey, { limit: rule.max, windowMs }, current)) return { allowed: true, retryAfter: null };
      const last = (await lastAttemptAt(deps.db, storageKey)) ?? current.getTime();
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((last + windowMs - current.getTime()) / 1000)) };
    }
  };
}
