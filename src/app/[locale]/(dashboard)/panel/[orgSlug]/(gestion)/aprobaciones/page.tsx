import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { ApprovalsNoticeProvider } from '@/components/panel/approvals-notice';
import { IdeaModerationCard } from '@/components/panel/idea-moderation-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/i18n/navigation';
import { getEnv } from '@/config/env';
import type { Locale } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { loadApprovalsData } from '@/services/panel/approvals-data';

/**
 * Aprobaciones de la entidad (Sprint 4.2a, `sch-sub-moderation`): la bandeja de ideas con su auditoría de firmas, el chat anónimo con quien la
 * propuso y la doble firma `DIRECTOR` + `COSIGNER`. Primero lo que pide una acción (propuestas nuevas y doble firma); después lo que sigue
 * recogiendo firmas y, plegado, lo último que se convirtió o se desestimó. Dinámica: depende de la sesión.
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
  const [data, t] = await Promise.all([
    loadApprovalsData(getPrisma(), getEnv().DATA_HMAC_SECRET, actor, organization.id),
    getTranslations({ locale, namespace: 'panel.approvals' })
  ]);
  // El Super-Admin entra al panel para ayudar, pero no modera ni firma en nombre de la entidad.
  const canModerate =
    !actor.isSuperadmin &&
    actor.memberships.some((membership) => membership.organizationId === organization.id && (membership.role === 'DIRECTOR' || membership.role === 'COSIGNER'));
  const card = (idea: (typeof data.open)[number]) => (
    <li key={idea.id}>
      <IdeaModerationCard orgSlug={organization.slug} idea={idea} minVotes={data.minVotes} categories={data.categories} canModerate={canModerate} />
    </li>
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-joy text-3xl font-bold text-varsity-navy">{t('title')}</h1>
        <p className="max-w-3xl text-ink-soft">{t('intro')}</p>
        <p className="max-w-3xl text-sm text-ink-soft">{t('antifraud')}</p>
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
      </ApprovalsNoticeProvider>
    </div>
  );
}
