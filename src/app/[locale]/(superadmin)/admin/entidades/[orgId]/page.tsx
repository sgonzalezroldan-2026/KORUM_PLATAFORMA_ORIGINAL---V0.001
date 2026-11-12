import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { BiInitiativesTables } from '@/components/admin/bi-initiatives-tables';
import { OrgCategories } from '@/components/admin/org-categories';
import { OrgInvoices } from '@/components/admin/org-invoices';
import { OrgKybReview } from '@/components/admin/org-kyb-review';
import { OrgSeats } from '@/components/admin/org-seats';
import { OrgTariffsForm } from '@/components/admin/org-tariffs-form';
import { Block } from '@/components/admin/entity-action';
import { RevenueSourcesChart } from '@/components/admin/revenue-sources-chart';
import { CurrencyText } from '@/components/ui/currency-text';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { requireSuperadminAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { getOrganization360 } from '@/repositories/console.repository';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'admin.org360' });
  return { title: t('metaTitle') };
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 border-b border-patio-rule py-1.5 last:border-0">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="font-bold">{children}</dd>
    </div>
  );
}

/**
 * Ficha 360º de una entidad (Sprint 5.2, `sa-sub-crm` / `renderSchoolCRM360`): su titular legal, la revisión del KYB y de la Ley 49/2002, las personas que
 * firman, sus tarifas y categorías propias, sus facturas Veri*factu y lo que aporta a KORUM (gráfico de 6 fuentes y tabla ordenable de sus iniciativas, con
 * el mismo pop-up ejecutivo que la portada). Abrirla queda en la auditoría (`superadmin.access`).
 */
export default async function AdminOrganizationPage({ params }: { params: Promise<{ locale: Locale; orgId: string }> }) {
  const { locale, orgId } = await params;
  setRequestLocale(locale);
  const { actor } = await requireSuperadminAccess(locale);
  const view = await getOrganization360(getPrisma(), actor, orgId);
  if (!view) notFound();
  const [t, format] = await Promise.all([getTranslations({ locale, namespace: 'admin.org360' }), getFormatter({ locale })]);
  const { organization } = view;
  const raisedCents = view.business.initiatives.reduce((total, row) => total + row.raisedCents, 0);
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeZone: 'Europe/Madrid' });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-col gap-2">
        <Link href="/admin/entidades" className="inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline">
          {t('back')}
        </Link>
        <h1 className="font-corp text-3xl font-extrabold text-varsity-navy" data-testid="org-title">
          {`${organization.name} (${organization.province})`}
        </h1>
        <p className="text-ink-soft">
          {t(`medal.${organization.medalRank}`)}
          {' · '}
          <span className="font-mono">{organization.walletId}</span>
          {organization.archived ? ` · ${t('archived')}` : ''}
        </p>
        <nav aria-label={t('nav.label')} className="flex flex-wrap gap-2">
          {(['titular', 'kyb', 'firmas', 'tarifas', 'categorias', 'facturas', 'negocio'] as const).map((anchor) => (
            <a key={anchor} href={`#${anchor}`} className="inline-flex min-h-11 items-center rounded-full border-2 border-varsity-navy/30 px-4 font-semibold text-varsity-navy hover:bg-varsity-navy/5">
              {t(`nav.${anchor}`)}
            </a>
          ))}
        </nav>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Block id="titular" title={t('holder.title')} hint={t('holder.hint')}>
          <dl className="text-sm" data-testid="holder-facts">
            <Fact label={t('holder.legalName')}>{organization.legalName}</Fact>
            <Fact label={t('holder.legalForm')}>{t(`legalForm.${organization.legalForm}` as 'legalForm.OTHER_NONPROFIT')}</Fact>
            <Fact label={t('holder.vertical')}>{t(`vertical.${organization.vertical}` as 'vertical.SCHOOL')}</Fact>
            <Fact label={t('holder.cif')}>{organization.cif ?? t('holder.none')}</Fact>
            <Fact label={t('holder.iban')}>{organization.ibanHint ?? t('holder.none')}</Fact>
            <Fact label={t('holder.destination')}>{organization.splitConfigured ? t('holder.destinationYes') : t('holder.destinationNo')}</Fact>
            <Fact label={t('holder.ley49')}>{!organization.ley49 ? t('holder.ley49No') : organization.ley49VerifiedAt ? t('holder.ley49Verified', { date: date(organization.ley49VerifiedAt) }) : t('holder.ley49Pending')}</Fact>
            <Fact label={t('holder.closed')}>{t('holder.closedValue', { year: organization.completedThisYear, historical: organization.completedHistorical })}</Fact>
            <Fact label={t('holder.sponsors')}>{t('holder.sponsorsValue', { active: organization.activeSponsorsCount, historical: organization.historicalSponsorsCount })}</Fact>
            <Fact label={t('holder.raised')}>
              <CurrencyText cents={raisedCents} />
            </Fact>
          </dl>
        </Block>

        <Block id="kyb" title={t('kyb.title')} hint={t('kyb.hint')}>
          <OrgKybReview organization={organization} documents={view.documents} />
        </Block>
      </div>

      <Block id="firmas" title={t('seats.title')} hint={t('seats.hint')}>
        <OrgSeats seats={view.seats} handover={view.handover} signatureMode={organization.signatureMode} />
      </Block>

      <div className="grid gap-6 lg:grid-cols-2">
        <Block id="tarifas" title={t('tariffs.title')} hint={t('tariffs.hint')}>
          <OrgTariffsForm organizationId={organization.id} customRules={view.customRules} tariffs={view.tariffs} globalTariffs={view.globalTariffs} />
        </Block>
        <Block id="categorias" title={t('categories.title')} hint={t('categories.hint')}>
          <OrgCategories organizationId={organization.id} categories={view.categories} />
        </Block>
      </div>

      <Block id="facturas" title={t('invoices.title')} hint={t('invoices.hint')}>
        <OrgInvoices invoices={view.invoices} locale={locale} />
      </Block>

      <Block id="negocio" title={t('business.title', { name: organization.name })} hint={t('business.hint')}>
        <RevenueSourcesChart real={view.business.real} projection={view.business.projection} />
        <BiInitiativesTables rows={view.business.initiatives} truncated={view.business.truncated} showTop10={false} />
      </Block>
    </div>
  );
}
