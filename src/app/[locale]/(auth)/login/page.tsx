import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { LoginForm } from '@/components/auth/login-form';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { safeNextPath } from '@/lib/auth/protected-paths';
import { localizedPath } from '@/lib/seo/marketing-routes';

type Params = { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Pick<Params, 'params'>): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'auth.login' });
  // Página de acceso: no aporta nada en un buscador (ARQUITECTURA_LANDING §2, ficha 3.2).
  return { title: t('metaTitle'), description: t('metaDescription'), robots: { index: false, follow: false } };
}

export default async function LoginPage({ params, searchParams }: Params) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'auth.login' });
  const query = await searchParams;
  const next = safeNextPath(typeof query.next === 'string' ? query.next : null);
  const continueUrl = `${localizedPath(locale, '/acceso/continuar')}${next ? `?next=${encodeURIComponent(next)}` : ''}`;
  const error = typeof query.error === 'string' ? query.error.slice(0, 64) : null;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-10">
      <section aria-labelledby="login-title" className="korum-trust-vault flex flex-col gap-4 p-6">
        <h1 id="login-title" className="font-corp text-3xl font-extrabold text-varsity-navy">
          {t('title')}
        </h1>
        <p className="text-ink-soft">{t('subtitle')}</p>
        <LoginForm continueUrl={continueUrl} loginUrl={localizedPath(locale, '/login')} initialError={error} />
      </section>
      <p className="text-center text-ink-soft">
        {t('noAccount')}{' '}
        <Link href="/registro-comunidad" className="font-bold text-varsity-navy underline underline-offset-4">
          {t('register')}
        </Link>
      </p>
    </div>
  );
}
