import { headers } from 'next/headers';
import { cache } from 'react';
import { getEnv } from '@/config/env';
import { verifyAccountSession, verifySuperadminSession, type VerifiedAccountActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { getPrisma } from '@/lib/prisma';
import { loadUserActor } from '@/repositories/actor';
import type { RequestMeta, SessionActor } from '@/repositories/tenant-guard';
import { hashAuditIp } from '@/services/audit/audit.service';
import { getAuth } from './server';

/**
 * Capa de sesión: el único punto donde la aplicación pasa de la cookie de Better Auth a un `SessionActor` (Regla 01 §4). Las membresías,
 * el rol de Super-Admin y si la sesión superó el segundo factor salen de la base de datos, nunca de lo que envía el navegador.
 */

export interface AuthSession {
  userId: string;
  sessionId: string;
  email: string;
  twoFactorEnabled: boolean;
  /**
   * La cuenta tiene el 2FA activado **y** esta sesión superó el TOTP, un código de respaldo o una llave de acceso. Un enlace mágico solo no lo
   * cumple, y una llave en una cuenta sin TOTP tampoco: no puede sustituir al 2FA obligatorio de quien firma (auditoría del 3.7, I1).
   */
  secondFactor: boolean;
}

/** IP solo como HMAC y navegador completo (la auditoría se queda solo con su familia). */
export async function currentRequestMeta(): Promise<RequestMeta> {
  const requestHeaders = await headers();
  const ip = requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() || requestHeaders.get('x-real-ip')?.trim();
  return { ipHash: ip ? hashAuditIp(getEnv().DATA_HMAC_SECRET, ip) : undefined, userAgent: requestHeaders.get('user-agent') ?? undefined };
}

/** Sesión de la petición actual (una consulta por petición gracias a `cache`). */
export const getAuthSession = cache(async (): Promise<AuthSession | null> => {
  const result = await getAuth().api.getSession({ headers: await headers() });
  if (!result) return null;
  const row = await getPrisma().session.findUnique({ where: { id: result.session.id }, select: { secondFactorVerifiedAt: true } });
  if (!row) return null;
  const twoFactorEnabled = Boolean((result.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled);
  return { userId: result.user.id, sessionId: result.session.id, email: result.user.email, twoFactorEnabled, secondFactor: twoFactorEnabled && row.secondFactorVerifiedAt !== null };
});

/** Actor de la petición actual para los repositorios (`authorizeTenant`). */
export const getSessionActor = cache(async (): Promise<SessionActor> => {
  const [session, requestMeta] = await Promise.all([getAuthSession(), currentRequestMeta()]);
  if (!session) return { kind: 'anonymous', requestMeta };
  return loadUserActor(getPrisma(), session.userId, requestMeta, { secondFactor: session.secondFactor });
});

/**
 * Super-Admin verificado para guardar ajustes, secretos o resolver casos de dinero (10 minutos desde el último TOTP). Lanza
 * `SuperadminRequiredError` (la ruta responde 403 genérico) y deja el intento en la auditoría.
 */
export async function requireVerifiedSuperadmin(operation: string): Promise<VerifiedSuperadminActor> {
  const session = await getAuthSession();
  return verifySuperadminSession(getPrisma(), { userId: session?.userId ?? '', sessionId: session?.sessionId ?? '', operation });
}

/** Titular de la cuenta reautenticado, para exportar o suprimir sus datos (Mi cuenta, Sprint 3.7). */
export async function requireVerifiedAccount(operation: string): Promise<VerifiedAccountActor> {
  const session = await getAuthSession();
  return verifyAccountSession(getPrisma(), { userId: session?.userId ?? '', sessionId: session?.sessionId ?? '', operation });
}
