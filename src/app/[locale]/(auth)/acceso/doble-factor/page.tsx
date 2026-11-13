import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound, redirect as redirectRaw } from 'next/navigation';
import { TwoFactorSetup } from '@/components/auth/two-factor-setup';
import { secondFactorIsFresh } from '@/core/security/verified-actor';
import { routing } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';
import { requireSession } from '@/lib/auth/guards';
import { safeNextPath } from '@/lib/auth/protected-paths';
import { localizedPath } from '@/lib/seo/marketing-routes';

type Params = { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Pick<Params, 'params'>): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'auth.twoFactor' });
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

/** Activar o pedir el segundo factor. Lo exigen el panel de firmantes y la consola antes de abrirse (`src/lib/auth/guards.ts`). */
export default async function TwoFactorPage({ params, searchParams }: Params) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const query = await searchParams;
  const next = safeNextPath(typeof query.next === 'string' ? query.next : null);
  const session = await requireSession(locale, `${localizedPath(locale, '/acceso/doble-factor')}${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  const nextUrl = next ?? localizedPath(locale, '/acceso/continuar');
  // Con el segundo factor ya superado **hace poco** no hay nada que pedir. Si caducó (la consola y los ajustes exigen un código de hace menos de 10 minutos), se vuelve a pedir: antes esta
  // página mandaba de vuelta a la pantalla de origen y quien llegaba desde «Volver a confirmar mi segundo factor» no podía hacer nada sin cerrar sesión.
  if (session.twoFactorEnabled && session.secondFactor && (await secondFactorIsFresh(getPrisma(), { userId: session.userId, sessionId: session.sessionId }))) redirectRaw(nextUrl);
  const t = await getTranslations({ locale, namespace: 'auth.twoFactor' });

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10">
      <section aria-labelledby="two-factor-title" className="korum-trust-vault flex flex-col gap-4 p-6">
        <h1 id="two-factor-title" className="font-corp text-3xl font-extrabold text-varsity-navy">
          {session.twoFactorEnabled ? t('verifyTitle') : t('setupTitle')}
        </h1>
        <p className="text-ink-soft">{t('why')}</p>
        <TwoFactorSetup enabled={session.twoFactorEnabled} nextUrl={nextUrl} />
      </section>
    </div>
  );
}
