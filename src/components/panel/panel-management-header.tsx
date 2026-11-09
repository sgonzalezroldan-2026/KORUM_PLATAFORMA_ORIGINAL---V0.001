import { getTranslations } from 'next-intl/server';
import { formatCents } from '@/core/finance/money';
import { medalGrantStatus } from '@/core/medals/medal-kit';
import type { Locale } from '@/i18n/routing';
import type { SignerStatus } from '@/repositories/organization.repository';
import { PanelNav } from './panel-nav';
import { ResendInvitationButton } from './resend-invitation-button';

/**
 * Cabecera de gestión del panel (Sprint 4.1, `id="env-school"` del prototipo): la hucha de la entidad, el estado de los documentos del titular,
 * los cupos del curso (importe exento, beca de medalla y mantenimiento) y las dos personas firmantes con su cargo. Es la misma en todas las
 * páginas del panel. Componente de servidor: recibe lo que el repositorio ya eligió campo a campo (sin IBAN, CIF ni contactos). Va antes del `h1`
 * de cada página, así que sus títulos son párrafos destacados y no encabezados (WCAG 1.3.1: el primer encabezado de la página es su `h1`).
 */

export interface PanelHeaderOrganization {
  slug: string;
  walletId: string;
  kybStatus: string;
  exemptLimitCents: number;
  exemptRemainingCents: number;
  medalGrantAvailableCents: number;
  medalGrantUsedInTitle: string | null;
  maintActive: boolean;
  maintPaidCents: number;
  maintAnnualCapCents: number;
  quotaPeriod: string | null;
}

export interface PanelHeaderSigner {
  userId: string;
  name: string;
  role: 'DIRECTOR' | 'COSIGNER';
  roleLabel: string | null;
  status: SignerStatus;
}

const KYB_TONE: Record<string, string> = {
  VERIFIED: 'bg-emerald-100 text-emerald-950',
  SUBMITTED: 'bg-amber-100 text-amber-950',
  PENDING: 'bg-amber-100 text-amber-950',
  REJECTED: 'bg-red-100 text-red-950'
};
const KYB_ICON: Record<string, string> = { VERIFIED: '🟢', SUBMITTED: '🔎', PENDING: '⏳', REJECTED: '⚠️' };

export async function PanelManagementHeader({
  locale,
  organization,
  signers,
  isDirector,
  pendingApprovals = 0
}: {
  locale: Locale;
  organization: PanelHeaderOrganization;
  signers: PanelHeaderSigner[];
  isDirector: boolean;
  /** Decisiones que esperan en «Aprobaciones» (comercios cobrados, propuestas nuevas e ideas en la doble firma). */
  pendingApprovals?: number;
}) {
  const t = await getTranslations({ locale, namespace: 'panel' });
  const ready = signers.filter((signer) => signer.status === 'ACTIVE').length;
  const grant = medalGrantStatus({ availableCents: organization.medalGrantAvailableCents, usedInTitle: organization.medalGrantUsedInTitle });
  const money = (cents: number) => formatCents(cents, locale);
  const strong = (chunks: React.ReactNode) => <strong className="font-corp font-extrabold tabular-nums text-varsity-emerald">{chunks}</strong>;
  const kyb = organization.kybStatus in KYB_TONE ? organization.kybStatus : 'PENDING';

  return (
    <section aria-label={t('header.label')} className="border-b-2 border-varsity-navy/10 bg-white/90">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-5">
        <div className="mobile-stack grid gap-4 md:grid-cols-3">
          <div className="korum-trust-vault flex flex-col gap-2 p-4">
            <p className="font-corp text-sm font-extrabold text-varsity-navy">{t('wallet.title')}</p>
            <p className="font-corp text-2xl font-extrabold tabular-nums text-varsity-navy">{organization.walletId}</p>
            <p className={`inline-flex w-fit items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold ${KYB_TONE[kyb]}`}>
              <span aria-hidden="true">{`${KYB_ICON[kyb]} `}</span>
              {t(`header.kyb.${kyb}`)}
            </p>
            <p className="text-sm text-ink-soft">{t('wallet.explain')}</p>
          </div>

          <div className="korum-trust-vault flex flex-col gap-2 p-4">
            <p className="font-corp text-sm font-extrabold text-varsity-navy">{t('header.quotas.title', { period: organization.quotaPeriod ?? '' }).trim()}</p>
            <ul className="flex flex-col gap-1.5 text-sm">
              <li>{t.rich('header.quotas.exempt', { remaining: money(organization.exemptRemainingCents), total: money(organization.exemptLimitCents), strong })}</li>
              <li>
                {grant.kind === 'USED'
                  ? t('header.quotas.medalUsed', { title: grant.title })
                  : grant.kind === 'AVAILABLE'
                    ? t.rich('header.quotas.medalAvailable', { amount: money(grant.cents), strong })
                    : t('header.quotas.medalNone')}
              </li>
              <li>
                {organization.maintActive
                  ? t('header.quotas.maintenance', { paid: money(organization.maintPaidCents), cap: money(organization.maintAnnualCapCents) })
                  : t('header.quotas.maintenanceOff', { amount: money(0) })}
              </li>
            </ul>
          </div>

          <div className="korum-trust-vault flex flex-col gap-3 p-4">
            <p className="font-corp text-sm font-extrabold text-varsity-navy">{t('signers.title', { ready, total: 2 })}</p>
            <ul className="flex flex-col gap-2">
              {signers.map((signer) => (
                <li key={`${signer.role}-${signer.userId}`} className="rounded-xl border-2 border-varsity-navy/15 bg-white p-2.5">
                  <p className="text-sm font-bold text-varsity-navy">
                    {signer.roleLabel ?? t(`signers.role.${signer.role}`)}
                    {' · '}
                    {signer.name}
                  </p>
                  <p className={`text-sm font-semibold ${signer.status === 'ACTIVE' ? 'text-varsity-emerald' : 'text-amber-900'}`}>
                    <span aria-hidden="true">{signer.status === 'ACTIVE' ? '✅ ' : '⏳ '}</span>
                    {t(`signers.status.${signer.status}`)}
                  </p>
                </li>
              ))}
            </ul>
            {isDirector && signers.some((signer) => signer.role === 'COSIGNER' && signer.status === 'INVITED') ? <ResendInvitationButton orgSlug={organization.slug} /> : null}
          </div>
        </div>
        <PanelNav orgSlug={organization.slug} pendingApprovals={pendingApprovals} />
      </div>
    </section>
  );
}
