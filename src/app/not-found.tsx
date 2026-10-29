import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { routing } from '@/i18n/routing';
import './globals.css';

/** 404 global, solo para rutas fuera de los idiomas (la página localizada vive en app/[locale]/not-found.tsx). */
export default async function GlobalNotFound() {
  const t = await getTranslations({ locale: routing.defaultLocale, namespace: 'notFound' });

  return (
    <html lang={routing.defaultLocale}>
      <body>
        <main className="mx-auto max-w-2xl px-4 py-24 text-center">
          <h1 className="font-corp text-3xl font-bold text-varsity-navy">{t('title')}</h1>
          <p className="mt-3 text-ink-soft">{t('description')}</p>
          <Link href="/" className="tactile-btn mt-6">
            {t('backHome')}
          </Link>
        </main>
      </body>
    </html>
  );
}
