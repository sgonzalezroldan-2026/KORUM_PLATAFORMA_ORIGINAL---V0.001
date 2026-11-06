import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound, redirect as redirectRaw } from 'next/navigation';
import { redirect } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { safeNextPath } from '@/lib/auth/protected-paths';
import { getAuthSession } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { localizedPath } from '@/lib/seo/marketing-routes';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Destino tras iniciar sesión: la ruta pedida (solo rutas internas) o, si no hay, el sitio de cada rol: la consola para el Super-Admin,
 * el panel de su entidad para quien firma, y la portada para familias y comercios. Recuerda en la cuenta el idioma con el que ha entrado
 * (Regla 03 §7: los emails le llegarán en ese idioma).
 */
export default async function ContinuePage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const session = await getAuthSession();
  if (!session) redirect({ href: '/login', locale });
  const db = getPrisma();
  const user = await db.user.update({
    where: { id: session!.userId },
    data: { locale },
    select: { isSuperadmin: true, memberships: { where: { role: { in: ['DIRECTOR', 'COSIGNER'] }, organization: { archivedAt: null } }, select: { organization: { select: { slug: true } } }, orderBy: { id: 'asc' }, take: 1 } }
  });
  const query = await searchParams;
  const next = safeNextPath(typeof query.next === 'string' ? query.next : null);
  if (next) redirectRaw(next);
  const home = user.isSuperadmin ? '/admin' : user.memberships[0] ? `/panel/${user.memberships[0].organization.slug}` : '/';
  redirectRaw(localizedPath(locale, home));
}
