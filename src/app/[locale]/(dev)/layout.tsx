import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { SiteHeader } from '@/components/layout/site-header';
import { isDevGalleryAvailable } from '@/config/dev-gallery';
import { routing } from '@/i18n/routing';
import { PrivateIntlProvider } from '@/components/layout/private-intl-provider';

// Herramientas internas de desarrollo: nunca se indexan.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function DevLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  // Antes que el proveedor de textos: en producción real la zona no existe y su 404 no debe llevar dentro el catálogo de la zona «dev».
  if (!isDevGalleryAvailable()) notFound();

  return (
    <PrivateIntlProvider zone="dev">
      <div className="flex min-h-dvh flex-col">
        <SiteHeader />
        <main id="contenido" className="flex-1">
          {children}
        </main>
      </div>
    </PrivateIntlProvider>
  );
}
