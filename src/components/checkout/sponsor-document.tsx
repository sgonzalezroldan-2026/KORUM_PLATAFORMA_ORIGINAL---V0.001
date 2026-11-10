import { getFormatter, getTranslations } from 'next-intl/server';
import QRCode from 'qrcode';
import { KorumLogo } from '@/components/brand/korum-logo';
import { CurrencyText } from '@/components/ui/currency-text';
import { formatCents } from '@/core/finance/money';
import type { Locale } from '@/i18n/routing';
import { Link } from '@/i18n/navigation';
import { SPONSOR_DOCUMENTS, sponsorDocumentPath, type SponsorDocumentKind } from '@/lib/seo/portal-routes';
import type { SponsorshipDocuments } from '@/repositories/sponsorship.repository';
import { PrintButton } from './print-button';
import { SponsorPoster } from './sponsor-poster';

/**
 * Documentos de un patrocinio (Sprints 3.5 y 4.2b, QA-F05), en una hoja limpia para imprimir o guardar. El **justificante** acredita que el 100 % del
 * nivel llega íntegro a la entidad; la **factura** es la de KORUM por su gestión publicitaria (fee + IVA), registrada en Veri*factu, y la
 * **rectificativa** la anula si el centro no admitió al comercio: nunca se mezclan los importes. El **cartel** es para el escaparate. Todos se abren
 * con el mismo enlace firmado del pedido; el CIF o NIF ya viene descifrado, solo para quien lo tiene.
 */

interface Props {
  kind: SponsorDocumentKind;
  locale: Locale;
  documents: SponsorshipDocuments;
  /** CIF o NIF del comercio, descifrado en servidor. */
  taxId: string;
  /** Razón social del emisor del ajuste de la consola: solo para facturas anteriores al 4.2b, que no la guardaban. */
  issuerName?: string;
  /** `?pedido=&sig=` con la firma del pedido, para pasar de un documento a otro; `null` si se entró con la firma del cartel (solo abre el cartel). */
  query: string | null;
  /** `?pedido=&sig=` con la firma propia del cartel: el enlace al cartel es el que se comparte y no abre los documentos fiscales. */
  posterQuery: string;
  /** URL pública absoluta del directorio de comercios de la entidad (el QR del cartel). */
  directoryUrl: string;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 border-b border-patio-rule py-2 sm:grid-cols-[12rem_1fr] sm:gap-3">
      <dt className="text-sm font-bold text-ink-soft">{label}</dt>
      <dd className="font-semibold text-ink wrap-anywhere">{children}</dd>
    </div>
  );
}

type Invoice = NonNullable<SponsorshipDocuments['sponsor']>['invoices'][number];

async function InvoiceSheet({ invoice, locale, documents, taxId, issuerName }: { invoice: Invoice; locale: Locale; documents: SponsorshipDocuments; taxId: string; issuerName?: string }) {
  const t = await getTranslations({ locale, namespace: 'portal.sponsorDocs' });
  const format = await getFormatter({ locale });
  const qrSvg = await QRCode.toString(invoice.verifactuQrUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  const date = (value: Date) => format.dateTime(value, { dateStyle: 'long', timeZone: 'Europe/Madrid' });
  return (
    <>
      <dl>
        <Row label={t('factura.number')}>
          <span className="font-mono" data-testid="invoice-number">
            {invoice.invoiceNumber}
          </span>
        </Row>
        {invoice.rectifiesInvoice ? (
          <Row label={t('rectificativa.rectifies')}>
            <span className="font-mono">{invoice.rectifiesInvoice.invoiceNumber}</span>
          </Row>
        ) : null}
        <Row label={t('factura.date')}>{date(invoice.issuedAt)}</Row>
        <Row label={t('factura.issuer')}>{invoice.issuerName ?? issuerName ?? t('factura.issuerFallback')}</Row>
        <Row label={t('factura.issuerTaxId')}>
          <span className="font-mono">{invoice.issuerTaxId}</span>
        </Row>
        <Row label={t('factura.recipient')}>{documents.sponsor?.name}</Row>
        <Row label={t('factura.recipientTaxId')}>
          <span className="font-mono">{taxId}</span>
        </Row>
        <Row label={t('factura.concept')}>{invoice.concept}</Row>
        <Row label={t('factura.base')}>
          <CurrencyText cents={invoice.baseAmountCents} />
        </Row>
        <Row label={t('factura.vat', { rate: format.number(invoice.taxRateBps / 100) })}>
          <CurrencyText cents={invoice.taxAmountCents} />
        </Row>
        <Row label={t('factura.total')}>
          <CurrencyText cents={invoice.totalAmountCents} className="font-corp text-lg font-extrabold text-varsity-navy" />
        </Row>
      </dl>
      <div className="flex items-center gap-4 rounded-xl border border-patio-rule p-3">
        <div aria-hidden="true" className="size-28 shrink-0 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: qrSvg }} />
        <div className="min-w-0 space-y-1 text-sm">
          <p className="font-bold text-varsity-navy">{t('factura.verifactu')}</p>
          <p className="break-all font-mono text-xs text-ink-soft">{invoice.verifactuHash.slice(0, 16)}</p>
          <a href={invoice.verifactuQrUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-bold text-sky-800 underline print:hidden">
            {t('factura.verify')}
          </a>
        </div>
      </div>
    </>
  );
}

export async function SponsorDocument({ kind, locale, documents, taxId, issuerName, query, posterQuery, directoryUrl }: Props) {
  const t = await getTranslations({ locale, namespace: 'portal.sponsorDocs' });
  const format = await getFormatter({ locale });
  const { sponsor } = documents;
  const invoice = sponsor?.invoices.find((entry) => entry.invoiceType === 'F1') ?? null;
  const rectifying = sponsor?.invoices.find((entry) => entry.invoiceType === 'R1') ?? null;
  const date = (value: Date) => format.dateTime(value, { dateStyle: 'long', timeZone: 'Europe/Madrid' });
  const returned = documents.status !== 'COMPLETED';
  // Solo se ofrecen los documentos que existen: la rectificativa, si se devolvió con factura; el cartel, mientras el comercio esté aprobado.
  const available = SPONSOR_DOCUMENTS.filter((entry) => (entry === 'rectificativa' ? rectifying !== null : entry === 'cartel' ? sponsor?.status === 'APPROVED' : true));
  const shownInvoice = kind === 'rectificativa' ? rectifying : invoice;

  return (
    <article className="korum-trust-vault mx-auto max-w-2xl space-y-4 p-6 print:border-0 print:shadow-none" aria-labelledby="document-title" data-testid={`sponsor-${kind}`}>
      <header className="flex items-center justify-between gap-3 border-b-2 border-varsity-navy pb-3">
        <KorumLogo size={40} />
        <p className="text-end text-sm font-bold text-ink-soft">{t('platform')}</p>
      </header>
      <h1 id="document-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
        {t(`${kind}.title`)}
      </h1>
      {returned && kind !== 'rectificativa' ? (
        <p role="status" className="rounded-xl bg-amber-100 p-3 font-bold text-amber-950">
          {t('returned')}
        </p>
      ) : null}

      {kind === 'cartel' ? (
        <SponsorPoster locale={locale} documents={documents} directoryUrl={directoryUrl} />
      ) : kind === 'justificante' ? (
        <>
          <dl>
            <Row label={t('justificante.sponsor')}>{sponsor?.name}</Row>
            <Row label={t('justificante.taxId')}>
              <span className="font-mono">{taxId}</span>
            </Row>
            <Row label={t('justificante.recipient')}>{documents.organization.legalName}</Row>
            {sponsor?.renewedFromId ? (
              <Row label={t('justificante.destination')}>{t('justificante.renewal')}</Row>
            ) : (
              <>
                <Row label={t('justificante.initiative')}>{documents.initiative.title}</Row>
                <Row label={t('justificante.destination')}>{sponsor?.isMatchingPool ? t('justificante.pool') : t('justificante.escrow')}</Row>
              </>
            )}
            <Row label={t('justificante.category')}>{t(`level.${sponsor?.categoryLevel ?? 'PLATA'}`)}</Row>
            <Row label={t('justificante.amount')}>
              <CurrencyText cents={documents.amountCents} className="font-corp text-lg font-extrabold text-varsity-navy" />
            </Row>
            <Row label={t('justificante.date')}>{date(documents.createdAt)}</Row>
          </dl>
          <p className="rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-950">
            {t(sponsor?.renewedFromId ? 'justificante.wholeRenewal' : 'justificante.whole', { amount: formatCents(documents.amountCents, locale) })}
          </p>
          <p className="text-sm text-ink-soft">{t('justificante.notInvoice')}</p>
        </>
      ) : shownInvoice ? (
        <>
          {kind === 'rectificativa' ? <p className="rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-950">{t('rectificativa.explain')}</p> : null}
          <InvoiceSheet invoice={shownInvoice} locale={locale} documents={documents} taxId={taxId} issuerName={issuerName} />
        </>
      ) : (
        <p role="status" className="rounded-xl bg-patio-cream p-4 text-ink">
          {t(kind === 'rectificativa' ? 'rectificativa.none' : 'factura.none')}
        </p>
      )}

      {query !== null && available.length > 1 ? (
        <nav aria-label={t('otherDocuments')} className="border-t border-patio-rule pt-3 print:hidden">
          <ul className="flex flex-wrap gap-2">
            {available
              .filter((entry) => entry !== kind)
              .map((entry) => (
                <li key={entry}>
                  <Link href={`${sponsorDocumentPath(documents.organization.slug, entry)}${entry === 'cartel' ? posterQuery : query}`} className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy/30 bg-white px-3 font-bold text-varsity-navy hover:border-varsity-navy">
                    {t(`${entry}.title`)}
                  </Link>
                </li>
              ))}
          </ul>
        </nav>
      ) : null}
      <PrintButton label={t('print')} />
    </article>
  );
}
