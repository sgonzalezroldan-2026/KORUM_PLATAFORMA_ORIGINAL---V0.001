import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ConsoleHeader } from '@/components/panel/console-header';
import { PanelManagementHeader } from '@/components/panel/panel-management-header';
import { routing } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';
import { loadPanelOverview } from '@/lib/panel/overview';
import { getPrisma } from '@/lib/prisma';
import { countWaitingFamilyTickets } from '@/repositories/support-inbox.repository';
import { countPendingApprovals } from '@/repositories/sponsor-moderation.repository';

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
  const { actor, organization } = await requirePanelAccess(locale, orgSlug);
  const [t, overview, pendingApprovals, pendingSupport] = await Promise.all([getTranslations({ locale, namespace: 'panel' }), loadPanelOverview(actor, organization.id), countPendingApprovals(getPrisma(), actor, organization.id), countWaitingFamilyTickets(getPrisma(), actor, organization.id)]);
  const isDirector = actor.memberships.some((membership) => membership.organizationId === organization.id && membership.role === 'DIRECTOR');

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Al imprimir (el cartel del Estudio) solo sale la hoja: las cabeceras no. */}
      <div className="print:hidden">
        <ConsoleHeader title={organization.name} subtitle={t('headerSubtitle')} />
        <PanelManagementHeader locale={locale} organization={overview.organization} signers={overview.signers} isDirector={isDirector} pendingApprovals={pendingApprovals} pendingSupport={pendingSupport} />
      </div>
      <main id="contenido" className="korum-paper-dots flex-1">
        {children}
      </main>
    </div>
  );
}
