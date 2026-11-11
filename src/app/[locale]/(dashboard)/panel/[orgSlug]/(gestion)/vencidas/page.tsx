import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { ApprovalsNoticeProvider } from '@/components/panel/approvals-notice';
import { ExpiredCampaignCard } from '@/components/panel/expired-campaign-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { loadExpiredCampaigns } from '@/repositories/expired-campaigns.repository';

/**
 * Campañas vencidas sin llegar a la meta (Sprint 4.4b, prototipo `id="sch-sub-escrow"`, «Gestión de plazos vencidos»): la decisión de la entidad
 * (votación de redimensionamiento o reembolso del 100 %), la votación en curso, el progreso del reembolso y lo ya resuelto. Dinámica: depende de la
 * sesión. El Super-Admin la ve sin poder decidir.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'panel.expired' });
  return { title: t('metaTitle') };
}

export default async function ExpiredCampaignsPage({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }) {
  const { locale, orgSlug } = await params;
  setRequestLocale(locale);
  const { actor, organization } = await requirePanelAccess(locale, orgSlug);
  const [view, t] = await Promise.all([loadExpiredCampaigns(getPrisma(), actor, organization.id), getTranslations({ locale, namespace: 'panel.expired' })]);
  const canAct = !actor.isSuperadmin && actor.memberships.some((membership) => membership.organizationId === organization.id && (membership.role === 'DIRECTOR' || membership.role === 'COSIGNER'));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-corp text-3xl font-extrabold text-varsity-navy">{t('title')}</h1>
        <p className="max-w-3xl text-ink-soft">{t('intro')}</p>
      </header>
      <ApprovalsNoticeProvider>
        {view.active.length === 0 && view.history.length === 0 ? (
          <EmptyState
            icon="🌱"
            title={t('empty.title')}
            description={t('empty.text')}
            action={
              <Link href={`/panel/${organization.slug}`} className="tactile-btn">
                {t('empty.cta')}
              </Link>
            }
          />
        ) : null}
        {view.active.map((campaign) => (
          <ExpiredCampaignCard key={campaign.id} orgSlug={organization.slug} locale={locale} campaign={campaign} canAct={canAct} />
        ))}
        {view.history.length > 0 ? (
          <section aria-labelledby="expired-history" className="flex flex-col gap-3">
            <h2 id="expired-history" className="font-corp text-xl font-extrabold text-varsity-navy">
              {t('historyTitle')}
            </h2>
            {view.history.map((campaign) => (
              <ExpiredCampaignCard key={campaign.id} orgSlug={organization.slug} locale={locale} campaign={campaign} canAct={canAct} />
            ))}
          </section>
        ) : null}
      </ApprovalsNoticeProvider>
    </div>
  );
}
