import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/layout/site-footer';
import { SiteHeader } from '@/components/layout/site-header';
import { routing } from '@/i18n/routing';
import { getPublicPlatformConfig } from '@/services/marketing/public-config';

/** Etiquetas de verificación de Google Search Console y Bing Webmaster Tools, leídas de los ajustes de la consola (skill de SEO §2). */
export async function generateMetadata(): Promise<Metadata> {
  const { verification } = await getPublicPlatformConfig();
  if (!verification.google && !verification.bing) return {};
  return {
    verification: {
      ...(verification.google ? { google: verification.google } : {}),
      ...(verification.bing ? { other: { 'msvalidate.01': verification.bing } } : {})
    }
  };
}

export default async function MarketingLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="contenido" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
