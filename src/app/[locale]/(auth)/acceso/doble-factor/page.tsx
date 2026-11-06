import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound, redirect as redirectRaw } from 'next/navigation';
import { TwoFactorSetup } from '@/components/auth/two-factor-setup';
import { routing } from '@/i18n/routing';
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
  if (session.twoFactorEnabled && session.secondFactor) redirectRaw(nextUrl);
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
