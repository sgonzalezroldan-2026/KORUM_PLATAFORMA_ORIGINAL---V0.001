import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { GateAdminCard } from '@/components/panel/gate-admin-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { loadGateAdmin } from '@/repositories/gate-admin.repository';

/**
 * Taquilla y portería (Sprint 4.5; el prototipo no tiene pantalla de portería ni de sorteo, la paridad se mide contra la ficha): los eventos y rifas con venta de entradas, el PIN de la puerta de cada uno y los móviles de
 * voluntarios que están dentro. Dinámica: depende de la sesión. El Super-Admin la ve sin poder crear PIN ni cerrar sesiones.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'panel.gate' });
  return { title: t('metaTitle') };
}

export default async function GateAdminPage({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }) {
  const { locale, orgSlug } = await params;
  setRequestLocale(locale);
  const { actor, organization } = await requirePanelAccess(locale, orgSlug);
  const [events, t] = await Promise.all([loadGateAdmin(getPrisma(), actor, organization.id), getTranslations({ locale, namespace: 'panel.gate' })]);
  const canAct = !actor.isSuperadmin && actor.memberships.some((membership) => membership.organizationId === organization.id && (membership.role === 'DIRECTOR' || membership.role === 'COSIGNER'));

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-corp text-3xl font-extrabold text-varsity-navy">{t('title')}</h1>
        <p className="max-w-3xl text-ink-soft">{t('intro')}</p>
      </header>
      {events.length === 0 ? (
        <EmptyState icon="🎟️" title={t('empty.title')} description={t('empty.text')} action={<Link href={`/panel/${orgSlug}/estudio`} className="tactile-btn">{t('empty.action')}</Link>} />
      ) : (
        <ul className="flex flex-col gap-4" data-testid="gate-admin-list">
          {events.map((event) => (
            <GateAdminCard key={event.id} orgSlug={organization.slug} event={event} canAct={canAct} />
          ))}
        </ul>
      )}
    </div>
  );
}
