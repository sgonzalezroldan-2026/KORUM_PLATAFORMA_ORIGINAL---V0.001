import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ConsoleHeader } from '@/components/panel/console-header';
import { SignChallengeForm, type SignSessionState } from '@/components/panel/sign-challenge-form';
import { routing } from '@/i18n/routing';
import { getAuthSession } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { localizedPath } from '@/lib/seo/marketing-routes';

export const dynamic = 'force-dynamic';

/** Título propio de la pestaña (WCAG 2.4.2): quien llega desde el email distingue la firma de sus otras pestañas. Nunca se indexa. */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const robots = { index: false, follow: false };
  if (!hasLocale(routing.locales, locale)) return { robots };
  const t = await getTranslations({ locale, namespace: 'panel.sign' });
  return { title: t('title'), robots };
}

/**
 * Página de la doble firma (`/panel/{slug}/firmar#t=…`, Sprint 4.2a). Queda fuera de la guardia del panel y del proxy a propósito: el token viaja
 * en el fragmento y una redirección a `/login` lo perdería al volver. La página no enseña nada sin sesión: solo guarda el enlace en la pestaña y
 * manda a iniciar sesión (o a pasar el segundo factor). Qué se firma lo decide el servidor con el token **y** la sesión de la persona a la que se
 * envió (`previewChallenge`); firmar lo vuelve a comprobar todo (`completeSignature`).
 */
export default async function SignPage({ params }: { params: Promise<{ locale: string; orgSlug: string }> }) {
  const { locale, orgSlug } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const organization = await getPrisma().organization.findFirst({ where: { slug: orgSlug, archivedAt: null }, select: { name: true, slug: true } });
  if (!organization) notFound();
  const [session, t] = await Promise.all([getAuthSession(), getTranslations({ locale, namespace: 'panel' })]);
  const state: SignSessionState = !session ? 'LOGIN' : session.secondFactor ? 'READY' : 'TWO_FACTOR';

  return (
    <div className="flex min-h-dvh flex-col">
      <ConsoleHeader title={organization.name} subtitle={t('headerSubtitle')} />
      <main id="contenido" className="korum-paper-dots flex-1">
        <div className="mx-auto flex max-w-xl flex-col gap-6 px-4 py-8">
          <SignChallengeForm orgSlug={organization.slug} session={state} nextPath={localizedPath(locale, `/panel/${organization.slug}/firmar`)} />
        </div>
      </main>
    </div>
  );
}
