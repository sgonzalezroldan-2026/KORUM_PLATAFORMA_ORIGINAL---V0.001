import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { PledgeCard, type PledgeCardData } from '@/components/hucha/pledge-card';
import { PledgeForm } from '@/components/hucha/pledge-form';
import { PledgeResult } from '@/components/hucha/pledge-result';
import { EmptyState } from '@/components/ui/empty-state';
import { checkoutOutcome } from '@/core/checkout/checkout-rules';
import { PROVINCES } from '@/core/onboarding/provinces';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { requireSession } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { localizedPath } from '@/lib/seo/marketing-routes';
import { HUCHA_PATH, huchaForOrganizationPath, portalPath } from '@/lib/seo/portal-routes';
import { loadPledgeOffer, loadPledgeResult, loadSuggestedOrganizations, loadUserPledges, type UserPledge } from '@/repositories/hucha.repository';
import { getSetting } from '@/services/settings/settings.service';
import { managePledgeAction, startPledgeAction } from './actions';

// Depende de la sesión: nunca se guarda en caché ni se comparte entre personas.
export const dynamic = 'force-dynamic';

type PageProps = { params: Promise<{ locale: string }>; searchParams: Promise<{ entidad?: string | string[]; pedido?: string | string[] }> };

export async function generateMetadata({ params }: Pick<PageProps, 'params'>): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'hucha' });
  return { title: t('metaTitle'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? '') : (value ?? ''));
const SLUG = /^[a-z0-9-]{1,80}$/;
const ORDER = /^KH[0-9A-F]{16}$/;

function toCard(pledge: UserPledge): PledgeCardData {
  return {
    id: pledge.id,
    status: pledge.status,
    statusReason: pledge.statusReason,
    monthlyAmountCents: pledge.monthlyAmountCents,
    feePerMonthCents: pledge.feePerMonthCents,
    totalMonths: pledge.totalMonths,
    executedMonths: pledge.executedMonths,
    skippedMonths: pledge.skippedMonths,
    nextChargeAt: pledge.nextChargeAt.toISOString(),
    initiativeId: pledge.initiativeId,
    contributedCents: pledge.contributedCents,
    organization: pledge.organization,
    card: pledge.paymentMethodToken ? { brand: pledge.paymentMethodToken.brand, last4: pledge.paymentMethodToken.last4, revoked: pledge.paymentMethodToken.revokedAt !== null } : null,
    months: pledge.contributions.map((row) => ({ cycle: row.pledgeCycle ?? 0, status: row.status, amountCents: row.amountCents, date: row.createdAt.toISOString(), campaign: row.initiative.title }))
  };
}

/**
 * Mi Hucha (Sprint 3.8, ancla `id="fview-mihucha"`). En modo `PLEDGE` es una **aportación mensual programada** a una entidad: nunca un saldo.
 * Con `DISABLED` no existe (404). El monedero regulado (`REGULATED_WALLET`) está aplazado: se explica en lugar de ofrecer nada. Todo sale de la
 * sesión; `?entidad=` abre el alta para esa entidad y `?pedido=` enseña cómo terminó el primer pago (solo si es de esta persona).
 */
export default async function HuchaPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const db = getPrisma();
  const mode = await getSetting(db, 'hucha.mode');
  if (mode !== 'PLEDGE' && mode !== 'REGULATED_WALLET') notFound();

  const query = await searchParams;
  const orgSlug = first(query.entidad);
  const order = first(query.pedido);
  const validSlug = SLUG.test(orgSlug);
  const session = await requireSession(locale, localizedPath(locale, validSlug ? huchaForOrganizationPath(orgSlug) : HUCHA_PATH));
  const t = await getTranslations({ locale, namespace: 'hucha' });

  const header = (
    <header className="flex flex-col gap-2">
      <h1 className="font-joy text-3xl font-bold text-varsity-navy">
        <span aria-hidden="true">{'🐷 '}</span>
        {t('title')}
      </h1>
      <p className="max-w-prose text-ink-soft">{t(mode === 'PLEDGE' ? 'intro' : 'walletIntro')}</p>
    </header>
  );
  if (mode === 'REGULATED_WALLET') {
    return (
      <div className="flex flex-col gap-8">
        {header}
        <EmptyState icon="🛠️" title={t('walletSoon.title')} description={t('walletSoon.text')} action={<Link href="/mi-cuenta" className="tactile-btn">{t('walletSoon.action')}</Link>} />
      </div>
    );
  }

  const now = new Date();
  const [pledges, offer, result, suggestions] = await Promise.all([
    loadUserPledges(db, session.userId, now),
    validSlug ? loadPledgeOffer(db, orgSlug, now) : Promise.resolve(null),
    ORDER.test(order) ? loadPledgeResult(db, session.userId, order) : Promise.resolve(null),
    loadSuggestedOrganizations(db, session.userId)
  ]);

  const mineSection = (
    <section id="mis-aportaciones" aria-labelledby="mis-aportaciones-title" className="flex scroll-mt-4 flex-col gap-4">
      <h2 id="mis-aportaciones-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
        {t('mine.title')}
      </h2>
      {pledges.length === 0 ? (
        <EmptyState icon="💛" title={t('mine.emptyTitle')} description={t('mine.emptyText')} headingLevel={3} />
      ) : (
        <div className="flex flex-col gap-4">
          {pledges.map((pledge) => (
            <PledgeCard key={pledge.id} pledge={toCard(pledge)} manage={managePledgeAction} />
          ))}
        </div>
      )}
    </section>
  );

  const startSection = (
    <section id="programar" aria-labelledby="programar-title" className="korum-trust-vault flex scroll-mt-4 flex-col gap-4 p-5">
      <h2 id="programar-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
        {offer ? t('start.titleFor', { organization: offer.name }) : t('start.title')}
      </h2>
      {offer ? (
        offer.campaigns.length > 0 ? (
          <PledgeForm offer={offer} provinces={offer.certificate ? PROVINCES.map((province) => ({ code: province.code, name: province.name })) : []} start={startPledgeAction} />
        ) : (
          <EmptyState
            icon="📭"
            title={t('start.noCampaignTitle', { organization: offer.name })}
            description={t('start.noCampaignText')}
            action={<Link href={portalPath(offer.slug)} className="tactile-btn">{t('start.visit', { organization: offer.name })}</Link>}
            headingLevel={3}
          />
        )
      ) : (
        <div className="flex flex-col gap-3">
          {orgSlug !== '' ? (
            <p role="alert" className="rounded-xl bg-amber-50 p-3 font-semibold text-amber-950">
              {t('start.notFound')}
            </p>
          ) : null}
          <p className="text-ink-soft">{t('start.pick')}</p>
          {suggestions.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {suggestions.map((organization) => (
                <li key={organization.slug}>
                  <Link href={huchaForOrganizationPath(organization.slug)} className="inline-flex min-h-11 items-center rounded-xl bg-white px-4 font-bold text-varsity-navy shadow-sm hover:bg-varsity-ivory">
                    {organization.name}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Link href="/" className="tactile-btn self-start">
              {t('start.find')}
            </Link>
          )}
        </div>
      )}
    </section>
  );

  return (
    <div className="flex flex-col gap-8" id="fview-mihucha">
      {header}
      {result ? (
        <PledgeResult outcome={checkoutOutcome(result.status, result.createdAt, now)} organization={result.organization.name} pledgeStatus={result.walletSubscription?.status ?? null} pledgeReason={result.walletSubscription?.statusReason ?? null} />
      ) : null}
      {/* Con aportaciones, primero las suyas: tras pagar, la recién activada queda a la vista y el alta de otra va después (QA de experiencia del 3.8). */}
      {pledges.length > 0 ? mineSection : startSection}
      {pledges.length > 0 ? startSection : mineSection}
    </div>
  );
}
