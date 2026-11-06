import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatCents } from '@/core/finance/money';
import { ResendInvitationButton } from '@/components/panel/resend-invitation-button';
import type { Locale } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { listSigners } from '@/repositories/organization.repository';

/**
 * Portada del panel tras el alta: la hucha de la entidad, el importe exento que le queda este curso, en qué punto está cada una de las dos
 * firmas (sin las dos, nada se aprueba ni se paga) y qué falta para poder publicar campañas con cobro (los documentos KYB).
 */
export default async function PanelHomePage({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }) {
  const { locale, orgSlug } = await params;
  setRequestLocale(locale);
  const { actor, organization } = await requirePanelAccess(locale, orgSlug);
  const signers = await listSigners(getPrisma(), actor, organization.id);
  const t = await getTranslations({ locale, namespace: 'panel' });
  const isDirector = actor.memberships.some((membership) => membership.organizationId === organization.id && membership.role === 'DIRECTOR');
  const ready = signers.filter((signer) => signer.status === 'ACTIVE').length;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-joy text-3xl font-bold text-varsity-navy">{t('welcome', { name: organization.name })}</h1>
        <p className="text-ink-soft">{t('intro')}</p>
      </header>

      <div className="mobile-stack grid gap-5 md:grid-cols-2">
        <section aria-labelledby="panel-wallet" className="korum-trust-vault flex flex-col gap-2 p-5">
          <h2 id="panel-wallet" className="font-corp text-lg font-extrabold text-varsity-navy">
            {t('wallet.title')}
          </h2>
          <p className="font-corp text-2xl font-extrabold tabular-nums text-varsity-navy">{organization.walletId}</p>
          <p className="text-sm text-ink-soft">{t('wallet.explain')}</p>
          <p className="mt-2">
            {t.rich('wallet.exempt', {
              remaining: formatCents(organization.exemptRemainingCents, locale),
              total: formatCents(organization.exemptLimitCents, locale),
              strong: (chunks) => <strong className="font-corp font-extrabold tabular-nums text-varsity-emerald">{chunks}</strong>
            })}
          </p>
        </section>

        <section aria-labelledby="panel-signers" className="korum-trust-vault flex flex-col gap-3 p-5">
          <h2 id="panel-signers" className="font-corp text-lg font-extrabold text-varsity-navy">
            {t('signers.title', { ready, total: 2 })}
          </h2>
          <ul className="flex flex-col gap-3">
            {signers.map((signer) => (
              <li key={`${signer.role}-${signer.userId}`} className="rounded-xl border-2 border-varsity-navy/15 bg-white p-3">
                <p className="font-bold text-varsity-navy">
                  {signer.roleLabel ?? t(`signers.role.${signer.role}`)}{' · '}{signer.name}
                </p>
                <p className={`text-sm font-semibold ${signer.status === 'ACTIVE' ? 'text-varsity-emerald' : 'text-amber-800'}`}>
                  <span aria-hidden="true">{signer.status === 'ACTIVE' ? '✅ ' : '⏳ '}</span>
                  {t(`signers.status.${signer.status}`)}
                </p>
              </li>
            ))}
          </ul>
          {isDirector && signers.some((signer) => signer.role === 'COSIGNER' && signer.status === 'INVITED') ? <ResendInvitationButton orgSlug={organization.slug} /> : null}
        </section>
      </div>

      <section aria-labelledby="panel-kyb" className="korum-notebook-sheet flex flex-col gap-2">
        <h2 id="panel-kyb" className="font-corp text-lg font-extrabold text-varsity-navy">
          {t('kyb.title')}
        </h2>
        <p>{t(`kyb.status.${organization.kybStatus}`)}</p>
        <p className="text-sm text-ink-soft">{t('kyb.documents')}</p>
      </section>
    </div>
  );
}
