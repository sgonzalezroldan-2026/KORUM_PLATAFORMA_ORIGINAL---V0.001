import { getTranslations } from 'next-intl/server';
import { ShareButton } from '@/components/portal/share-button';
import { checkoutOutcome, resultNavigation, sponsorshipNotice } from '@/core/checkout/checkout-rules';
import { formatCents } from '@/core/finance/money';
import { localizeRow } from '@/core/public/view-model';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { absoluteUrl } from '@/lib/seo/marketing-routes';
import { checkoutPath, initiativePath, portalPath, sponsorDocumentPath, sponsorsPath } from '@/lib/seo/portal-routes';
import type { getSponsorshipResult } from '@/repositories/sponsorship.repository';
import { ClearCheckoutDraft, PendingRefresh } from './checkout-celebration';

/**
 * Vuelta del pago de un comercio (QA-F05 · QA-F10). Igual que la de las familias, el estado sale **solo** de lo que guardó el webhook firmado.
 * Confirmado: agradecimiento, adónde va el dinero, qué pasa ahora (el centro revisa el comercio) y la descarga del justificante y de la factura.
 */

type SponsorshipRow = NonNullable<Awaited<ReturnType<typeof getSponsorshipResult>>>;

const linkClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-center font-extrabold';

export async function SponsorshipResult({ row, orgSlug, initiativeId, locale, order, signature }: { row: SponsorshipRow; orgSlug: string; initiativeId: number; locale: Locale; order: string; signature: string }) {
  const t = await getTranslations({ locale, namespace: 'portal.result' });
  const outcome = checkoutOutcome(row.status, row.createdAt, new Date());
  const { initiative, sponsor } = row;
  const title = localizeRow({ title: initiative.title, description: '', translationsJson: initiative.translationsJson }, locale, initiative.organization.contentLocale).row.title;
  const method = row.paymentMethod === 'BIZUM' ? 'BIZUM' : 'CARD';
  const otherMethod = method === 'BIZUM' ? 'CARD' : 'BIZUM';
  // La campaña pudo cerrarse mientras se pagaba (Sprint 5.5): su ficha ya no es pública y su enlace daría un 404.
  const nav = resultNavigation(initiative.status);
  const back = nav.showInitiative ? (
    <Link href={initiativePath(orgSlug, initiativeId)} className={`${linkClass} border-2 border-patio-rule-strong bg-white text-varsity-navy`}>
      {t('back')}
    </Link>
  ) : (
    <Link href={portalPath(orgSlug)} className={`${linkClass} border-2 border-patio-rule-strong bg-white text-varsity-navy`} data-testid="result-to-portal">
      {t('backToEntity', { entity: initiative.organization.name })}
    </Link>
  );

  if (outcome === 'FAILED' || outcome === 'UNCONFIRMED') {
    const retry = `${checkoutPath(orgSlug, initiativeId)}?modo=comercio&reintento=1`;
    return (
      <section className="korum-trust-vault mx-auto max-w-lg space-y-4 p-6 text-center" aria-labelledby="result-title">
        <h1 id="result-title" className="font-joy text-2xl font-bold text-varsity-navy">
          {outcome === 'FAILED' ? t(`failed.title.${method}`) : t('unconfirmed.title')}
        </h1>
        <p role="alert" className="font-semibold text-ink">
          {outcome === 'FAILED' ? t('failed.description') : t('unconfirmed.description')}
        </p>
        {nav.canRetry ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <Link href={`${retry}&metodo=${method}`} className={`${linkClass} bg-varsity-emerald text-white`}>{t('failed.retry')}</Link>
            <Link href={`${retry}&metodo=${otherMethod}`} className={`${linkClass} bg-varsity-navy text-white`}>{t(`failed.switchTo.${otherMethod}`)}</Link>
          </div>
        ) : (
          <p className="rounded-xl bg-patio-cream p-3 text-ink" data-testid="result-closed">{t('closedNoRetry')}</p>
        )}
        {back}
      </section>
    );
  }

  if (outcome === 'PENDING' || outcome === 'RETURNED') {
    return (
      <section className="korum-trust-vault mx-auto max-w-lg space-y-4 p-6 text-center" aria-labelledby="result-title">
        <h1 id="result-title" className="font-joy text-2xl font-bold text-varsity-navy">
          {outcome === 'PENDING' ? t('pending.title') : t(`sponsor.returned.${sponsorshipNotice('RETURNED', row.amountCents, sponsor, initiative.status, row.status)}.title`)}
        </h1>
        <p role="status" className="text-ink">
          {outcome === 'PENDING' ? t('pending.description') : t(`sponsor.returned.${sponsorshipNotice('RETURNED', row.amountCents, sponsor, initiative.status, row.status)}.description`)}
        </p>
        {outcome === 'PENDING' ? <PendingRefresh /> : null}
        {back}
      </section>
    );
  }

  const query = `?${new URLSearchParams({ pedido: order, sig: signature }).toString()}`;
  // Adónde va su dinero según cómo están ahora el comercio y la campaña (auditoría de seguridad del 5.5a): nunca se dice que suma a una campaña cerrada.
  const wholeKey = sponsorshipNotice('CONFIRMED', row.amountCents, sponsor, initiative.status, row.status);
  return (
    <section className="korum-trust-vault mx-auto max-w-lg space-y-5 p-6 text-center" aria-labelledby="result-title" data-testid="sponsorship-celebration">
      <ClearCheckoutDraft initiativeId={initiativeId} />
      <h1 id="result-title" className="font-joy text-2xl font-bold text-varsity-navy">
        <span aria-hidden="true">{'🏪 '}</span>
        {t('sponsor.title', { name: sponsor?.name ?? '' })}
      </h1>
      <p lang={initiative.organization.contentLocale === locale ? undefined : initiative.organization.contentLocale} className="font-corp text-lg font-extrabold text-varsity-navy wrap-anywhere">
        {title}
      </p>
      <p className="font-corp font-bold tabular-nums text-ink">{t('confirmed.paid', { total: formatCents(row.totalChargedCents, locale) })}</p>
      {/* Lleva un importe: zona de dinero, con Plus Jakarta y cifras tabulares (nunca Fredoka en cifras, Regla 01). */}
      <p role="status" className="font-corp text-lg font-bold tabular-nums text-emerald-900">
        <span aria-hidden="true">{'💛 '}</span>
        {t(`sponsor.whole.${wholeKey}`, { amount: formatCents(row.amountCents, locale) })}
      </p>
      {/* «El centro revisará tu comercio» solo mientras esté por revisar: un comercio ya admitido no tiene nada pendiente. */}
      {sponsor?.status === 'PENDING' ? <p className="rounded-2xl bg-patio-cream p-4 text-ink">{t('sponsor.review', { level: t(`sponsor.level.${sponsor.categoryLevel}`) })}</p> : null}
      {sponsor?.autoRenew ? <p className="text-sm text-ink-soft">{t('sponsor.reminder')}</p> : null}
      <div className="space-y-2 rounded-2xl border border-sky-300 bg-sky-50 p-4">
        <p className="font-semibold text-ink">{t('sponsor.documents')}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Link href={`${sponsorDocumentPath(orgSlug, 'justificante')}${query}`} className={`${linkClass} bg-sky-800 text-white`} data-testid="sponsor-doc-justificante">
            <span aria-hidden="true">{'🧾 '}</span>
            {t('sponsor.justificante')}
          </Link>
          <Link href={`${sponsorDocumentPath(orgSlug, 'factura')}${query}`} className={`${linkClass} bg-sky-800 text-white`} data-testid="sponsor-doc-factura">
            <span aria-hidden="true">{'📄 '}</span>
            {t('sponsor.factura')}
          </Link>
        </div>
      </div>
      {/* Invitar a compartir solo mientras la campaña recauda: con ella cerrada se contradiría con el aviso de arriba (auditoría de experiencia). */}
      {nav.canRetry ? (
        <div className="space-y-2 rounded-2xl bg-patio-cream p-4">
          <p className="font-semibold text-ink">{t('confirmed.share')}</p>
          <div className="flex justify-center">
            <ShareButton target={{ title, entityName: initiative.organization.name, url: absoluteUrl(locale, initiativePath(orgSlug, initiativeId)), groups: [] }} />
          </div>
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {back}
        <Link href={sponsorsPath(orgSlug)} className={`${linkClass} border-2 border-patio-rule-strong bg-white text-varsity-navy`}>
          {t('sponsor.directory')}
        </Link>
      </div>
    </section>
  );
}
