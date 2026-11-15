import { getSessionFromCtx, isAPIError } from 'better-auth/api';
import type { Db } from '@/lib/db';
import { clearAttempts, countAttempt } from '@/lib/rate-limit';
import { AUTH_SIGN_IN_FAILURE_RULE } from '@/lib/rate-limit-rules';
import { trustedClientIp } from '@/lib/trusted-ip';
import { coarseUserAgent } from '@/repositories/tenant-guard';
import { hashAuditIp, writeAudit } from '@/services/audit/audit.service';

/**
 * Inicios de sesión fallidos repetidos (Sprint 5.8a, trazabilidad). Un fallo suelto es un despiste y no se anota; **tres seguidos** contra la misma cuenta
 * (o desde la misma red, si la cuenta no existe) dejan `auth.sign_in_failed_repeatedly` en la auditoría, y después una fila cada vez más espaciada (a los
 * 8, 18, 38, 78… fallos: el hueco se dobla), para que un ataque insistente se vea sin llenar un registro que no se borra: mil fallos seguidos dejan 8 filas. Entrar bien pone el contador a cero; también 15 minutos sin fallos.
 *
 * - **No frena a nadie:** los topes por red de Better Auth, el bloqueo de la cuenta y el del segundo factor siguen siendo quienes paran un ataque. Esto
 *   solo deja constancia.
 * - **Sin datos personales:** la fila lleva el identificador de la cuenta (si existe), el método, cuántos fallos van, la red como HMAC y la familia del
 *   navegador. Nunca el email tecleado ni la contraseña. Si la cuenta no existe, el objetivo es `Account` · `unknown`: no se guarda ni la huella del email.
 * - Un fallo al anotar nunca cambia la respuesta del inicio de sesión.
 */

export type SignInMethod = 'password' | 'email_code' | 'second_factor' | 'passkey';

/** Rutas de Better Auth que son un intento de entrar o de superar el segundo factor. */
export const SIGN_IN_ATTEMPT_PATHS: Readonly<Record<string, SignInMethod>> = {
  '/sign-in/email': 'password',
  '/sign-in/email-otp': 'email_code',
  '/two-factor/verify-totp': 'second_factor',
  '/two-factor/verify-backup-code': 'second_factor',
  '/passkey/verify-authentication': 'passkey'
};

export const FAILED_SIGN_IN_FIRST_NOTICE = 3;
/** Primer hueco tras el aviso inicial; los siguientes se doblan. */
export const FAILED_SIGN_IN_REPEAT_EVERY = 5;

/** ¿Toca dejar fila con este número de fallos seguidos? Al tercero y, después, a los 8, 18, 38, 78…: cada hueco es el doble del anterior. */
export function failedSignInIsNoteworthy(failures: number): boolean {
  if (!Number.isSafeInteger(failures) || failures < FAILED_SIGN_IN_FIRST_NOTICE) return false;
  const steps = (failures - FAILED_SIGN_IN_FIRST_NOTICE) / FAILED_SIGN_IN_REPEAT_EVERY + 1;
  // 1, 2, 4, 8…: potencias de dos.
  return Number.isInteger(steps) && (steps & (steps - 1)) === 0;
}

export interface FailedSignInDeps {
  db: Db;
  hmacSecret: string;
  now?: () => Date;
}

type SessionContext = Parameters<typeof getSessionFromCtx>[0];
export type SignInHookContext = SessionContext & {
  path?: string;
  body?: unknown;
  headers?: Headers;
  request?: Request;
  context: { returned?: unknown; newSession?: { user: { id: string } } | null };
};

const emailOf = (body: unknown): string | null => {
  const email = body && typeof body === 'object' && 'email' in body ? (body as { email: unknown }).email : null;
  return typeof email === 'string' && email.length > 0 && email.length <= 320 ? email.trim().toLowerCase() : null;
};

const userKey = (userId: string) => `${AUTH_SIGN_IN_FAILURE_RULE.prefix}u:${userId}`;
const networkKey = (ipHash: string | null) => `${AUTH_SIGN_IN_FAILURE_RULE.prefix}n:${ipHash ?? 'unknown'}`;

/** Nombre de la cookie con la que Better Auth recuerda, entre la contraseña y el código, de quién es el segundo factor que se está pidiendo. */
const TWO_FACTOR_COOKIE = 'two_factor';

/** Lo que Better Auth pone en el contexto de sus rutas y este módulo usa para leer esa cookie. Todo opcional: si falta algo, no se identifica a nadie. */
interface ChallengeContext {
  getSignedCookie?: (name: string, secret: string) => Promise<string | false | null | undefined>;
  context: {
    secret?: string;
    createAuthCookie?: (name: string) => { name: string };
    internalAdapter?: { findVerificationValue?: (identifier: string) => Promise<{ value: string } | null | undefined> };
  };
}

/**
 * La cuenta del segundo factor que se pide **al entrar**, cuando aún no hay sesión: tras la contraseña buena, Better Auth guarda quién es en una cookie
 * firmada y en una verificación (igual que hace él mismo en `verify-two-factor`). Sin esto, quien tiene la contraseña y prueba códigos quedaba anotado
 * como «cuenta desconocida» y contado por red, justo el caso más grave (auditoría de seguridad del 5.8a).
 */
async function challengeUserId(ctx: SignInHookContext): Promise<string | null> {
  const challenge = ctx as unknown as ChallengeContext;
  const context = challenge.context;
  if (!context.secret || !context.createAuthCookie || !context.internalAdapter?.findVerificationValue || !challenge.getSignedCookie) return null;
  // Llamadas como método, sin sacarlas del objeto: algunas dependen de él.
  const token = await challenge.getSignedCookie(context.createAuthCookie(TWO_FACTOR_COOKIE).name, context.secret);
  if (!token) return null;
  const verification = await context.internalAdapter.findVerificationValue(token);
  return verification?.value || null;
}

/**
 * La cuenta contra la que se intentó entrar: la del email tecleado; en el segundo factor, la de la sesión ya abierta o la de quien acaba de poner bien la
 * contraseña y está en el paso del código.
 */
async function targetUserId(deps: FailedSignInDeps, ctx: SignInHookContext, method: SignInMethod): Promise<string | null> {
  const email = emailOf(ctx.body);
  if (email) return (await deps.db.user.findUnique({ where: { email }, select: { id: true } }))?.id ?? null;
  const open = (await getSessionFromCtx(ctx).catch(() => null))?.user.id ?? null;
  if (open || method !== 'second_factor') return open;
  const candidate = await challengeUserId(ctx).catch((error: unknown) => {
    console.error('No se pudo leer el reto del segundo factor', error);
    return null;
  });
  // Solo si esa cuenta existe: el valor sale de una verificación de Better Auth, pero aquí no se da nada por supuesto.
  return candidate ? ((await deps.db.user.findUnique({ where: { id: candidate }, select: { id: true } }))?.id ?? null) : null;
}

/** Se llama tras cada ruta de `SIGN_IN_ATTEMPT_PATHS`, haya ido bien o mal. */
export async function trackSignInAttempt(deps: FailedSignInDeps, ctx: SignInHookContext): Promise<void> {
  const method = ctx.path ? SIGN_IN_ATTEMPT_PATHS[ctx.path] : undefined;
  if (!method) return;
  try {
    if (!isAPIError(ctx.context.returned)) {
      // El contador vuelve a cero solo cuando de verdad se abre una sesión. Una contraseña buena que todavía tiene que pasar el segundo factor no lo borra:
      // si no, quien conoce la contraseña podría probar códigos sin llegar nunca a tres fallos seguidos.
      const userId = ctx.context.newSession?.user.id ?? null;
      if (!userId) return;
      // Con el segundo factor activado, la contraseña (o el código por email) sola no cuenta como haber entrado: Better Auth crea una sesión que retira
      // enseguida para pedir el código. Para esas cuentas el contador solo se borra al superar el segundo factor o al entrar con una llave.
      if (method === 'password' || method === 'email_code') {
        const account = await deps.db.user.findUnique({ where: { id: userId }, select: { twoFactorEnabled: true } });
        if (account?.twoFactorEnabled) return;
      }
      await clearAttempts(deps.db, userKey(userId));
      return;
    }
    const now = deps.now?.() ?? new Date();
    const read = (name: string) => ctx.headers?.get(name) ?? ctx.request?.headers.get(name) ?? null;
    const ip = trustedClientIp(read);
    const ipHash = ip ? hashAuditIp(deps.hmacSecret, ip) : null;
    const userId = await targetUserId(deps, ctx, method);
    const key = userId ? userKey(userId) : networkKey(ipHash);
    // El número exacto de este fallo, sumado y leído en una sola escritura: con varios intentos a la vez, cada uno recibe el suyo y ninguno se salta el aviso.
    const failures = await countAttempt(deps.db, key, AUTH_SIGN_IN_FAILURE_RULE.windowMs, now);
    if (!failedSignInIsNoteworthy(failures)) return;
    await writeAudit(deps.db, {
      actorType: 'USER',
      actorUserId: null,
      action: 'auth.sign_in_failed_repeatedly',
      targetType: userId ? 'User' : 'Account',
      targetId: userId ?? 'unknown',
      ipHash,
      userAgent: coarseUserAgent(read('user-agent') ?? undefined),
      metadata: { method, failures, windowMinutes: Math.round(AUTH_SIGN_IN_FAILURE_RULE.windowMs / 60_000), knownAccount: userId !== null }
    });
  } catch (error) {
    console.error('No se pudo anotar el inicio de sesión fallido', error);
  }
}
