import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/layout/site-footer';
import { SiteHeader } from '@/components/layout/site-header';
import { routing } from '@/i18n/routing';
import { PrivateIntlProvider } from '@/components/layout/private-intl-provider';

/** Entorno 0 · acceso y alta: misma cabecera y pie que la web, sobre el fondo de patio. */
export default async function AuthLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return (
    <PrivateIntlProvider zone="auth">
      <div className="flex min-h-dvh flex-col">
        <SiteHeader />
        <main id="contenido" className="korum-paper-dots flex-1">
          {children}
        </main>
        <SiteFooter />
      </div>
    </PrivateIntlProvider>
  );
}
