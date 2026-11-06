import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ConsoleHeader } from '@/components/panel/console-header';
import { routing } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Entorno 2 · panel de la entidad. La guardia se resuelve aquí, antes de enviar nada: sin sesión lleva a `/login`; sin cargo de firmante en
 * esta entidad responde 403; sin el segundo factor en esta sesión lleva a activarlo. La portería (`/porteria`) queda fuera de este grupo:
 * entra con el PIN del evento.
 */
export default async function PanelLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string; orgSlug: string }> }) {
  const { locale, orgSlug } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const { organization } = await requirePanelAccess(locale, orgSlug);
  const t = await getTranslations({ locale, namespace: 'panel' });

  return (
    <div className="flex min-h-dvh flex-col">
      <ConsoleHeader title={organization.name} subtitle={t('headerSubtitle')} />
      <main id="contenido" className="korum-paper-dots flex-1">
        {children}
      </main>
    </div>
  );
}
