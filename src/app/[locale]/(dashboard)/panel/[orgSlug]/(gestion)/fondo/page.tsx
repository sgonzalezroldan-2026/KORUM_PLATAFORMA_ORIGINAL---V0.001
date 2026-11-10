import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { ActivityFundHistory } from '@/components/panel/activity-fund-history';
import { ActivityFundPending, ActivityFundRequestForm } from '@/components/panel/activity-fund-actions';
import { ApprovalsNoticeProvider } from '@/components/panel/approvals-notice';
import { FormAlert } from '@/components/auth/auth-ui';
import { CurrencyText } from '@/components/ui/currency-text';
import { EmptyState } from '@/components/ui/empty-state';
import { getEnv } from '@/config/env';
import { formatCents } from '@/core/finance/money';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { loadActivityFund } from '@/services/panel/activity-fund-data';

/**
 * Fondo de actividades de la entidad (Sprint 4.2f, decisión del promotor del 2026-11-10): el dinero de comercios admitidos que no se pudo llevar a
 * ninguna campaña antes de que venciera su bolsa. Lo que hay, de quién llegó, la liquidación a la cuenta de la entidad con su destino y la doble firma,
 * y el historial con su justificante. Dinámica: depende de la sesión. El Super-Admin la ve sin poder pedir ni firmar.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'panel.fund' });
  return { title: t('metaTitle') };
}

export default async function ActivityFundPage({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }) {
  const { locale, orgSlug } = await params;
  setRequestLocale(locale);
  const { actor, organization } = await requirePanelAccess(locale, orgSlug);
  const [fund, t, format] = await Promise.all([
    loadActivityFund(getPrisma(), getEnv().DATA_HMAC_SECRET, actor, organization.id),
    getTranslations({ locale, namespace: 'panel.fund' }),
    getFormatter({ locale })
  ]);
  const canAct = !actor.isSuperadmin && actor.memberships.some((membership) => membership.organizationId === organization.id && (membership.role === 'DIRECTOR' || membership.role === 'COSIGNER'));
  const date = (iso: string) =>
    format.dateTime(new Date(iso), {
      dateStyle: 'long',
      timeZone: 'Europe/Madrid'
    });
  const empty = fund.availableCents === 0 && !fund.pending && fund.stuckCents === 0;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-corp text-3xl font-extrabold text-varsity-navy">{t('title')}</h1>
        <p className="max-w-3xl text-ink-soft">{t('intro')}</p>
      </header>
      <ApprovalsNoticeProvider>
        <section aria-labelledby="fund-summary" className="korum-trust-vault flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy bg-white p-5" data-testid="fund-summary">
          <h2 id="fund-summary" className="text-sm font-extrabold uppercase text-ink-soft">
            {t('summary.title')}
          </h2>
          <p className="font-corp text-3xl font-extrabold tabular-nums text-varsity-navy">
            <CurrencyText cents={fund.availableCents} />
          </p>
          {fund.deadline && (fund.availableCents > 0 || fund.pending) ? <p className="font-semibold text-varsity-navy">{`⏳ ${t('summary.deadline', { date: date(fund.deadline) })}`}</p> : null}
          <p className="text-sm text-ink-soft">{t('summary.where')}</p>
          {fund.pending ? (
            <p className="font-semibold tabular-nums text-varsity-navy">
              {t('summary.inPayout', {
                amount: formatCents(fund.pending.amountCents, locale)
              })}
            </p>
          ) : null}
          {fund.stuckCents > 0 ? (
            <p className="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-950" data-testid="fund-stuck">
              {t('summary.stuck', {
                amount: formatCents(fund.stuckCents, locale)
              })}
            </p>
          ) : null}
          {!fund.payable && !empty ? (
            <FormAlert tone="info">
              {t('summary.notPayable')}{' '}
              <Link href={`/panel/${organization.slug}/ajustes#documentos`} className="font-bold underline underline-offset-4">
                {t('summary.notPayableCta')}
              </Link>
            </FormAlert>
          ) : null}
        </section>

        {fund.pending ? (
          <ActivityFundPending orgSlug={organization.slug} payout={fund.pending} canAct={canAct} />
        ) : fund.availableCents > 0 && fund.payable && canAct ? (
          <ActivityFundRequestForm orgSlug={organization.slug} availableCents={fund.availableCents} />
        ) : empty ? (
          <EmptyState
            title={t('empty.title')}
            description={t('empty.text')}
            action={
              <Link href={`/panel/${organization.slug}/aprobaciones#comercios`} className="tactile-btn">
                {t('empty.cta')}
              </Link>
            }
          />
        ) : null}

        {empty && fund.deposits.length === 0 && fund.history.length === 0 ? null : (
          <>
            <section aria-labelledby="fund-deposits" className="flex flex-col gap-3">
              <h2 id="fund-deposits" className="font-corp text-xl font-extrabold text-varsity-navy">
                {t('deposits.title', { count: fund.deposits.length })}
              </h2>
              {fund.deposits.length === 0 ? (
                <p className="text-ink-soft">{t('deposits.none')}</p>
              ) : (
                <ul className="flex flex-col gap-2" data-testid="fund-deposits">
                  {fund.deposits.map((deposit) => (
                    <li key={deposit.id} className="flex flex-col gap-1 rounded-xl border-2 border-varsity-navy/15 bg-white p-3 md:flex-row md:items-center md:justify-between">
                      <span className="flex flex-col">
                        <span className="wrap-break-word font-bold text-varsity-navy">{`${deposit.sponsor} · ${t(`levels.${deposit.level}`)}`}</span>
                        <span className="text-sm text-ink-soft">
                          {t('deposits.meta', {
                            origin: deposit.origin,
                            charged: date(deposit.chargedAt),
                            arrived: date(deposit.createdAt)
                          })}
                        </span>
                      </span>
                      <span className="font-corp font-extrabold tabular-nums text-varsity-navy">
                        <CurrencyText cents={deposit.amountCents} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <ActivityFundHistory orgSlug={organization.slug} locale={locale} history={fund.history} canAct={canAct} />
          </>
        )}
      </ApprovalsNoticeProvider>
    </div>
  );
}
