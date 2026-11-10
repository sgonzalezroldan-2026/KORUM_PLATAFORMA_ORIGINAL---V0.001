import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import QRCode from 'qrcode';
import { PosterConfigurator } from '@/components/panel/poster-configurator';
import { EmptyState } from '@/components/ui/empty-state';
import { canPrintPoster, printedUrl } from '@/core/studio/poster-rules';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { absoluteUrl } from '@/lib/seo/marketing-routes';
import { INITIATIVE_ID_PATTERN, initiativePath } from '@/lib/seo/portal-routes';
import { getPosterData } from '@/repositories/studio.repository';
import { ResourceNotFoundError } from '@/repositories/tenant-guard';
import { publicFileSrc } from '@/services/portal/achievements-data';

/**
 * Cartel A4 con QR de una campaña que está recaudando (Sprint 4.3, `poster-modal`). El QR lleva a su ficha pública en el idioma en que escribe la entidad
 * (las familias del centro), y el título y el mensaje por defecto salen en ese mismo idioma. Dinámica: depende de la sesión.
 */
export const dynamic = 'force-dynamic';

export default async function PosterPage({ params }: { params: Promise<{ locale: Locale; orgSlug: string; id: string }> }) {
  const { locale, orgSlug, id } = await params;
  setRequestLocale(locale);
  if (!INITIATIVE_ID_PATTERN.test(id)) notFound();
  const { actor, organization } = await requirePanelAccess(locale, orgSlug);
  let data: Awaited<ReturnType<typeof getPosterData>>;
  try {
    data = await getPosterData(getPrisma(), actor, organization.id, Number(id));
  } catch (error) {
    if (error instanceof ResourceNotFoundError) notFound();
    throw error;
  }
  const t = await getTranslations({ locale, namespace: 'panel.studio.poster' });

  const back = (
    <Link href={`/panel/${orgSlug}/estudio?iniciativa=${data.initiative.id}`} className="inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline underline-offset-4 print:hidden">
      {t('back')}
    </Link>
  );
  if (!canPrintPoster(data.initiative.status)) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8">
        {back}
        <EmptyState icon="🖨️" title={t('unavailable.title')} description={t('unavailable.description')} headingLevel={1} />
      </div>
    );
  }

  const contentT = await getTranslations({ locale: data.organization.contentLocale, namespace: 'panel.studio.poster' });
  // Una entrada o una papeleta no es una donación y su garantía no es la de una meta: el cartel de taquilla dice lo aprobado para taquilla (3.4).
  const kind = data.initiative.format === 'TICKETING' ? (data.initiative.ticketSubtype === 'RAFFLE' ? 'Raffle' : 'Tickets') : '';
  const url = absoluteUrl(data.organization.contentLocale, initiativePath(data.organization.slug, data.initiative.id));
  const [qrSvg, qrPng] = await Promise.all([QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }), QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 1024 })]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-8 print:p-0">
      <header className="flex flex-col gap-2 print:hidden">
        {back}
        <h1 className="font-joy text-3xl font-bold text-varsity-navy wrap-anywhere">{t('title', { title: data.initiative.title })}</h1>
        <p className="max-w-3xl text-ink-soft">{t('intro')}</p>
      </header>
      <PosterConfigurator
        logoSrc={data.organization.logoFileId ? publicFileSrc(data.organization.logoFileId) : null}
        walletId={data.initiative.walletEscrowId}
        qrSvg={qrSvg}
        qrPng={qrPng}
        displayUrl={printedUrl(url)}
        defaultTitle={contentT('defaultTitle')}
        defaultMessage={contentT(`defaultMessage${kind}`)}
        contentLang={data.organization.contentLocale}
        sheet={{
          label: contentT('sheetLabel'),
          platform: contentT('platform'),
          payments: contentT('payments'),
          withKorum: contentT('withKorum', { entity: data.organization.name }),
          qrLabel: contentT('qrLabel'),
          guarantee: contentT(kind === '' ? 'guarantee' : 'guaranteeTickets', { wallet: data.initiative.walletEscrowId })
        }}
      />
    </div>
  );
}
