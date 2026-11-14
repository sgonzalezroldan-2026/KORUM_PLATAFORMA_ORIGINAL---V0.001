import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { KorumLogo } from '@/components/brand/korum-logo';
import { LanguageSwitcher } from '@/components/ui/language-switcher';
import { routing } from '@/i18n/routing';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Modo portería: sin cuenta, con el PIN de cada evento. No comparte la guardia ni la cabecera del panel de firmantes. Lleva su propio selector de idioma
 * (Regla 03 §7, Sprint 5.5b): un voluntario puede pasar la puerta a castellano, catalán o inglés sin perder la sesión (la cookie de portería vale en todos).
 */
export default async function GateLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'gate' });
  return (
    <div className="flex min-h-dvh flex-col bg-varsity-navy-deep text-varsity-ivory">
      <header className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3 print:hidden">
        <KorumLogo size={36} tone="dark" />
        <p className="font-corp flex-1 font-extrabold">{t('mode')}</p>
        <LanguageSwitcher tone="dark" />
      </header>
      <main id="contenido" className="mx-auto w-full max-w-3xl flex-1 px-4 pb-10">
        {children}
      </main>
    </div>
  );
}
