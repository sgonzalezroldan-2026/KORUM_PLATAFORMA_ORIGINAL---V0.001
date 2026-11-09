import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { ApprovalsNoticeProvider } from '@/components/panel/approvals-notice';
import { IdeaModerationCard } from '@/components/panel/idea-moderation-card';
import { SponsorModerationCard } from '@/components/panel/sponsor-moderation-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/i18n/navigation';
import { getEnv } from '@/config/env';
import type { Locale } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { loadApprovalsData } from '@/services/panel/approvals-data';
import { loadSponsorModeration } from '@/services/panel/sponsor-moderation-data';
import { MAX_LOGO_BYTES } from '@/services/storage/sponsor-logo.service';

/**
 * Aprobaciones de la entidad (Sprints 4.2a y 4.2b, `sch-sub-moderation`): la bandeja de ideas con su auditoría de firmas, el chat anónimo con quien
 * la propuso y la doble firma `DIRECTOR` + `COSIGNER`, y la de comercios amigos (`sch-sponsors-moderation-list`). En cada una, primero lo que pide
 * una acción; plegado, lo último que se cerró. Dinámica: depende de la sesión.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'panel.approvals' });
  return { title: t('metaTitle') };
}

export default async function ApprovalsPage({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }) {
  const { locale, orgSlug } = await params;
  setRequestLocale(locale);
  const { actor, organization } = await requirePanelAccess(locale, orgSlug);
  const [data, sponsors, t, tSponsors] = await Promise.all([
    loadApprovalsData(getPrisma(), getEnv().DATA_HMAC_SECRET, actor, organization.id),
    loadSponsorModeration(getPrisma(), actor, organization.id),
    getTranslations({ locale, namespace: 'panel.approvals' }),
    getTranslations({ locale, namespace: 'panel.sponsors' })
  ]);
  // El Super-Admin entra al panel para ayudar, pero no modera ni firma en nombre de la entidad.
  const canModerate =
    !actor.isSuperadmin && actor.memberships.some((membership) => membership.organizationId === organization.id && (membership.role === 'DIRECTOR' || membership.role === 'COSIGNER'));
  const card = (idea: (typeof data.open)[number]) => (
    <li key={idea.id}>
      <IdeaModerationCard orgSlug={organization.slug} idea={idea} minVotes={data.minVotes} categories={data.categories} canModerate={canModerate} />
    </li>
  );

  const sponsorCard = (sponsor: (typeof sponsors.open)[number]) => (
    <li key={sponsor.id}>
      <SponsorModerationCard orgSlug={organization.slug} sponsor={sponsor} canModerate={canModerate} maxLogoBytes={MAX_LOGO_BYTES} />
    </li>
  );
  const sponsorsToDecide = sponsors.open.filter((sponsor) => sponsor.needsDecision).length;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-joy text-3xl font-bold text-varsity-navy">{t('title')}</h1>
        <p className="max-w-3xl text-ink-soft">{t('intro')}</p>
        <p className="max-w-3xl text-sm text-ink-soft">{t('antifraud')}</p>
        {sponsorsToDecide > 0 ? (
          <a href="#comercios" className="inline-flex min-h-11 items-center self-start font-bold text-varsity-navy underline underline-offset-4" data-testid="jump-to-sponsors">
            {tSponsors('jump', { count: sponsorsToDecide })}
          </a>
        ) : null}
      </header>

      <ApprovalsNoticeProvider>
        <section aria-labelledby="approvals-open" className="flex flex-col gap-4">
          <h2 id="approvals-open" className="font-corp text-xl font-extrabold text-varsity-navy">
            {t('openTitle', { count: data.open.length })}
          </h2>
          {data.open.length === 0 ? (
            <EmptyState
              icon="💡"
              title={t('empty.title')}
              description={t('empty.description')}
              headingLevel={3}
              playful
              action={
                <Link href={`/${organization.slug}/ideas`} className="tactile-btn">
                  {t('empty.cta')}
                </Link>
              }
            />
          ) : (
            <ul className="flex flex-col gap-4">{data.open.map(card)}</ul>
          )}
        </section>

        {data.closed.length > 0 ? (
          <details className="rounded-2xl border border-stone-200 bg-white p-4">
            <summary className="min-h-11 cursor-pointer font-corp text-lg font-extrabold text-varsity-navy">{t('closedTitle', { count: data.closed.length })}</summary>
            <ul className="mt-4 flex flex-col gap-4">{data.closed.map(card)}</ul>
          </details>
        ) : null}

        <section id="comercios" aria-labelledby="approvals-sponsors" className="flex scroll-mt-4 flex-col gap-4 border-t-2 border-varsity-navy/10 pt-6">
          <header className="flex flex-col gap-1">
            <h2 id="approvals-sponsors" className="font-corp text-xl font-extrabold text-varsity-navy">
              {tSponsors('title', { count: sponsorsToDecide })}
            </h2>
            <p className="max-w-3xl text-sm text-ink-soft">{tSponsors('intro')}</p>
          </header>
          {/* Su propio aviso de éxito, encima de los comercios: al aprobar uno de abajo, el foco no salta al principio de la página. */}
          <ApprovalsNoticeProvider>
            {sponsors.open.length === 0 ? (
              <EmptyState
                icon="🏪"
                title={tSponsors('empty.title')}
                description={tSponsors('empty.description')}
                headingLevel={3}
                playful
                action={
                  <Link href={`/${organization.slug}/comercios`} className="tactile-btn">
                    {tSponsors('empty.cta')}
                  </Link>
                }
              />
            ) : (
              <ul className="flex flex-col gap-4">{sponsors.open.map(sponsorCard)}</ul>
            )}
            {sponsors.closed.length > 0 ? (
              <details className="rounded-2xl border border-stone-200 bg-white p-4">
                <summary className="min-h-11 cursor-pointer font-corp text-lg font-extrabold text-varsity-navy">{tSponsors('closedTitle', { count: sponsors.closed.length })}</summary>
                <ul className="mt-4 flex flex-col gap-4">{sponsors.closed.map(sponsorCard)}</ul>
              </details>
            ) : null}
          </ApprovalsNoticeProvider>
        </section>
      </ApprovalsNoticeProvider>
    </div>
  );
}
