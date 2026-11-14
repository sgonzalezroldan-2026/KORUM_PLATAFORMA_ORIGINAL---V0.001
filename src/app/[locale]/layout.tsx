import type { Metadata, Viewport } from 'next';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { Fredoka, Plus_Jakarta_Sans } from 'next/font/google';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { CookieNotice } from '@/components/layout/cookie-notice';
import { DemoBar } from '@/components/layout/demo-bar';
import { ToastProvider } from '@/components/ui/toast-provider';
import { NON_ESSENTIAL_COOKIES } from '@/config/cookies';
import { publicClientMessages } from '@/i18n/client-messages';
import { routing } from '@/i18n/routing';
import '../globals.css';

const plusJakarta = Plus_Jakarta_Sans({
  // Solo «latin» (Sprint 5.5): cubre todas las letras de es, ca y en (à, ç, ñ, l·l…); con «latin-ext» se precargaba otro archivo por fuente que
  // ninguna página usaba (aviso de consola). Un carácter de fuera (un nombre propio con «ł») se dibuja con la fuente de respaldo.
  subsets: ['latin'],
  variable: '--font-plus-jakarta',
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap'
});

const fredoka = Fredoka({
  // Solo «latin» (Sprint 5.5): cubre todas las letras de es, ca y en (à, ç, ñ, l·l…); con «latin-ext» se precargaba otro archivo por fuente que
  // ninguna página usaba (aviso de consola). Un carácter de fuera (un nombre propio con «ł») se dibuja con la fuente de respaldo.
  subsets: ['latin'],
  variable: '--font-fredoka',
  weight: ['600', '700'],
  display: 'swap'
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#101f38'
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'metadata' });

  return {
    metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
    title: { default: t('title'), template: '%s · KORUM' },
    description: t('description'),
    applicationName: 'KORUM'
  };
}

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const [t, messages] = await Promise.all([getTranslations({ locale, namespace: 'common' }), getMessages({ locale })]);

  return (
    <html lang={locale} className={`${plusJakarta.variable} ${fredoka.variable}`}>
      <body>
        {/* Al navegador solo le llegan las secciones de textos de lo público; las zonas privadas amplían el proveedor en su layout (QA-X01). */}
        <NextIntlClientProvider messages={publicClientMessages(messages)}>
          <a
            href="#contenido"
            className="sr-only focus:not-sr-only focus:fixed focus:inset-s-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-varsity-navy focus:px-4 focus:py-3 focus:text-varsity-ivory"
          >
            {t('skipToContent')}
          </a>
          {/* Solo en el entorno de demostración (Regla 01 §6); en producción no se monta. */}
          {process.env.NEXT_PUBLIC_DEMO_MODE === 'true' ? <DemoBar /> : null}
          <ToastProvider>{children}</ToastProvider>
          {/* Sin cookies no esenciales registradas no se monta nada: el aviso solo existe cuando hace falta (CUMPLIMIENTO §6). */}
          {NON_ESSENTIAL_COOKIES.length > 0 ? <CookieNotice cookies={NON_ESSENTIAL_COOKIES} /> : null}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
