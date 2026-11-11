import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { ApprovalsNoticeProvider } from '@/components/panel/approvals-notice';
import { CampaignPayoutForm } from '@/components/panel/campaign-payout-form';
import { CampaignPayoutHistory } from '@/components/panel/campaign-payout-history';
import { CampaignPayoutPending } from '@/components/panel/campaign-payout-pending';
import { CurrencyText } from '@/components/ui/currency-text';
import { EmptyState } from '@/components/ui/empty-state';
import { getEnv } from '@/config/env';
import { buildJobDeps } from '@/core/jobs/job-deps';
import { SPLIT_WINDOW_WARNING_DAYS } from '@/core/finance/campaign-window';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { loadCampaignPayouts, type ReadyInitiativeView } from '@/services/panel/campaign-payouts-data';
import { MAX_INVOICE_BYTES } from '@/services/payouts/payout-invoice.service';

/**
 * Liquidaciones de las campañas conseguidas (Sprint 4.4a, prototipo `id="sch-sub-escrow"`, `closeAndPublishAchievedInitiative`): lo que hay en la hucha de
 * cada una, el aviso de los 90 días de Paycomet, lo que falta antes de liquidar, el destino con la factura del proveedor, la doble firma y el historial.
 * Las fotos Antes / Después y el agradecimiento se publican desde Logros (las familias las ven cuando la liquidación está hecha). Dinámica: depende de la
 * sesión. El Super-Admin la ve sin poder pedir ni firmar.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'panel.payouts' });
  return { title: t('metaTitle') };
}

const BLOCKER_LINKS: Partial<Record<ReadyInitiativeView['blockers'][number], string>> = {
  SPONSORS_PENDING: 'aprobaciones#comercios',
  KYB_NOT_VERIFIED: 'ajustes#documentos'
};

export default async function CampaignPayoutsPage({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }) {
  const { locale, orgSlug } = await params;
  setRequestLocale(locale);
  const { actor, organization } = await requirePanelAccess(locale, orgSlug);
  const db = getPrisma();
  const provider = await buildJobDeps(db).paymentProvider();
  const [view, t, format] = await Promise.all([
    loadCampaignPayouts(db, getEnv().DATA_HMAC_SECRET, actor, organization.id, { providerPayoutAvailable: typeof provider.providerPayoutAccount === 'function' }),
    getTranslations({ locale, namespace: 'panel.payouts' }),
    getFormatter({ locale })
  ]);
  const canAct = !actor.isSuperadmin && actor.memberships.some((membership) => membership.organizationId === organization.id && (membership.role === 'DIRECTOR' || membership.role === 'COSIGNER'));
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'long', timeZone: 'Europe/Madrid' });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-corp text-3xl font-extrabold text-varsity-navy">{t('title')}</h1>
        <p className="max-w-3xl text-ink-soft">{t('intro')}</p>
      </header>
      <ApprovalsNoticeProvider>
        {view.ready.length === 0 && view.history.length === 0 ? (
          <EmptyState
            icon="🏆"
            title={t('empty.title')}
            description={t('empty.text')}
            action={
              <Link href={`/panel/${organization.slug}`} className="tactile-btn">
                {t('empty.cta')}
              </Link>
            }
          />
        ) : null}

        {view.ready.map((initiative) => {
          const blocked = initiative.blockers.length > 0 || !view.payable;
          return (
            <section key={initiative.id} aria-labelledby={`payout-${initiative.id}`} className="korum-trust-vault flex flex-col gap-4 rounded-2xl border-2 border-varsity-navy bg-white p-5" data-testid={`payout-ready-${initiative.id}`}>
              <div className="flex flex-col gap-1">
                <span className="self-start rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-extrabold uppercase text-emerald-900">{t('badge')}</span>
                <h2 id={`payout-${initiative.id}`} className="wrap-break-word font-joy text-2xl font-bold text-varsity-navy">
                  {`🏆 ${initiative.title}`}
                </h2>
                <p className="font-corp text-sm tabular-nums text-ink-soft">{initiative.walletEscrowId}</p>
              </div>
              <dl className="mobile-stack grid gap-2 font-corp tabular-nums sm:grid-cols-2 lg:grid-cols-4">
                {(
                  [
                    ['raised', initiative.raisedCents],
                    ['korumFee', initiative.korumFeeCents],
                    ['gateway', initiative.gatewayInGoalCents],
                    ['net', initiative.netPaidCents]
                  ] as const
                ).map(([key, cents]) => (
                  <div key={key} className={key === 'net' ? 'rounded-xl border-2 border-varsity-emerald bg-emerald-50 p-3' : 'rounded-xl border border-varsity-navy/15 p-3'}>
                    <dt className="text-xs font-bold uppercase text-ink-soft">{t(`figures.${key}`)}</dt>
                    <dd className="text-lg font-extrabold text-varsity-navy">
                      <CurrencyText cents={cents} />
                    </dd>
                  </div>
                ))}
              </dl>
              {initiative.window ? (
                <p
                  className={initiative.window.daysLeft <= SPLIT_WINDOW_WARNING_DAYS ? 'rounded-xl border-2 border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-950' : 'text-sm font-semibold text-varsity-navy'}
                  data-testid={`payout-window-${initiative.id}`}
                >
                  {`⏳ ${t('window', { date: date(initiative.window.deadline), days: initiative.window.daysLeft })}`}
                </p>
              ) : null}
              {initiative.blockers.length > 0 ? (
                <ul className="flex flex-col gap-2" aria-label={t('blockersLabel')} data-testid={`payout-blockers-${initiative.id}`}>
                  {initiative.blockers.map((blocker) => (
                    <li key={blocker} className="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-950">
                      {t(`blockers.${blocker}`)}{' '}
                      {BLOCKER_LINKS[blocker] ? (
                        <Link href={`/panel/${organization.slug}/${BLOCKER_LINKS[blocker]}`} className="font-bold underline underline-offset-4">
                          {t(`blockerCta.${blocker}`)}
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {initiative.pending ? (
                <CampaignPayoutPending
                  orgSlug={organization.slug}
                  initiativeId={initiative.id}
                  payout={initiative.pending}
                  invoiceRequired={initiative.invoiceRequired}
                  canAct={canAct}
                  blocked={blocked}
                  editor={<CampaignPayoutForm orgSlug={organization.slug} initiative={initiative} providerPayoutAvailable={view.providerPayoutAvailable} organizationAccount={view.organizationAccount} maxInvoiceBytes={MAX_INVOICE_BYTES} />}
                />
              ) : canAct && !blocked ? (
                <CampaignPayoutForm orgSlug={organization.slug} initiative={initiative} providerPayoutAvailable={view.providerPayoutAvailable} organizationAccount={view.organizationAccount} maxInvoiceBytes={MAX_INVOICE_BYTES} />
              ) : !canAct ? (
                <p className="text-sm text-ink-soft">{t('readOnly')}</p>
              ) : null}
              <Link href={`/panel/${organization.slug}/logros`} className="inline-flex min-h-11 w-fit items-center text-sm font-bold text-varsity-navy underline underline-offset-4">
                {`📷 ${t('photosHint')}`}
              </Link>
            </section>
          );
        })}

        <CampaignPayoutHistory orgSlug={organization.slug} locale={locale} history={view.history} canAct={canAct} />
      </ApprovalsNoticeProvider>
    </div>
  );
}
