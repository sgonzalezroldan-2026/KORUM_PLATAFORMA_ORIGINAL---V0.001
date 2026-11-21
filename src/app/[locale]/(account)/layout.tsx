import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/layout/site-footer';
import { SiteHeader } from '@/components/layout/site-header';
import { PrivacyChangeBanner } from '@/components/legal/privacy-change-banner';
import { routing } from '@/i18n/routing';
import { PrivateIntlProvider } from '@/components/layout/private-intl-provider';

/**
 * Entorno 1 · *Mi cuenta* (`/mi-cuenta`, Sprint 3.7): lo de una persona en todas sus comunidades, por eso vive fuera de `[orgSlug]`. Misma
 * cabecera y pie que la web; las páginas comprueban la sesión con la base de datos y nunca se guardan en caché. Bajo la cabecera, la franja de un cambio
 * importante de la política de privacidad, si lo hay (Sprint 5.10b).
 */
export default async function AccountLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return (
    <PrivateIntlProvider zone="account">
      <div className="flex min-h-dvh flex-col">
        <SiteHeader />
        {/* Cambio importante de la política de privacidad: 30 días (Sprint 5.10b, decisión 90). */}
        <PrivacyChangeBanner locale={locale} />
        <main id="contenido" className="korum-paper-dots flex-1 px-4 py-6">
          <div className="mx-auto w-full max-w-4xl">{children}</div>
        </main>
        <SiteFooter />
      </div>
    </PrivateIntlProvider>
  );
}
