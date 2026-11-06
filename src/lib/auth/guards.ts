import { forbidden, notFound } from 'next/navigation';
import { cache } from 'react';
import { redirect } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';
import { localizedPath } from '@/lib/seo/marketing-routes';
import { authorizeSuperadmin, authorizeTenant, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { getAuthSession, getSessionActor, type AuthSession } from './session';

/**
 * Guardias de los entornos protegidos, para los `layout.tsx` (Regla 01 §4, QA-M02). Orden de las comprobaciones:
 *
 * 1. **Sin sesión** → a `/login`, con la ruta de vuelta.
 * 2. **Sin derecho** (no es firmante de esa entidad, o no es Super-Admin) → `403` de verdad (`forbidden()`), registrado en `AuditLog`.
 * 3. **Sin segundo factor en esta sesión** (o sin TOTP configurado) → a `/acceso/doble-factor`: el panel de firmantes y la consola no se abren
 *    con un enlace mágico solo.
 */

export type PanelOrganization = { id: string; slug: string; name: string; vertical: 'SCHOOL' | 'SPORTS_CLUB' | 'CULTURAL'; walletId: string; kybStatus: string; exemptRemainingCents: number; exemptLimitCents: number };

async function signedIn(locale: Locale, nextPath: string): Promise<AuthSession> {
  const session = await getAuthSession();
  if (!session) redirect({ href: { pathname: '/login', query: { next: nextPath } }, locale });
  return session!;
}

function requireSecondFactor(session: AuthSession, locale: Locale, nextPath: string): void {
  if (!session.twoFactorEnabled || !session.secondFactor) redirect({ href: { pathname: '/acceso/doble-factor', query: { next: nextPath } }, locale });
}

async function orForbidden(check: Promise<unknown>): Promise<void> {
  try {
    await check;
  } catch (error) {
    if (error instanceof TenantAccessError) forbidden();
    throw error;
  }
}

/** Panel de una entidad: solo sus firmantes (`DIRECTOR`, `COSIGNER`) y el Super-Admin (queda en `superadmin.access`). Una vez por petición (layout y página). */
export const requirePanelAccess = cache(async (locale: Locale, orgSlug: string): Promise<{ session: AuthSession; actor: Extract<SessionActor, { kind: 'user' }>; organization: PanelOrganization }> => {
  const nextPath = localizedPath(locale, `/panel/${orgSlug}`);
  const session = await signedIn(locale, nextPath);
  const organization = await getPrisma().organization.findFirst({
    where: { slug: orgSlug, archivedAt: null },
    select: { id: true, slug: true, name: true, vertical: true, walletId: true, kybStatus: true, exemptRemainingCents: true, exemptLimitCents: true }
  });
  if (!organization) notFound();
  const actor = await getSessionActor();
  await orForbidden(authorizeTenant(getPrisma(), actor, organization.id, { roles: ['DIRECTOR', 'COSIGNER'], action: 'panel.view', targetType: 'Organization' }));
  requireSecondFactor(session, locale, nextPath);
  return { session, actor: actor as Extract<SessionActor, { kind: 'user' }>, organization };
});

/** Consola del Super-Admin (`/admin/*`). Cada apertura queda en `superadmin.access`. */
export const requireSuperadminAccess = cache(async (locale: Locale): Promise<{ session: AuthSession; actor: Extract<SessionActor, { kind: 'user' }> }> => {
  const nextPath = localizedPath(locale, '/admin');
  const session = await signedIn(locale, nextPath);
  const actor = await getSessionActor();
  await orForbidden(authorizeSuperadmin(getPrisma(), actor, 'admin.view', 'Console'));
  requireSecondFactor(session, locale, nextPath);
  return { session, actor: actor as Extract<SessionActor, { kind: 'user' }> };
});

/** Página del doble factor: basta con tener sesión. */
export async function requireSession(locale: Locale, nextPath: string): Promise<AuthSession> {
  return signedIn(locale, nextPath);
}
