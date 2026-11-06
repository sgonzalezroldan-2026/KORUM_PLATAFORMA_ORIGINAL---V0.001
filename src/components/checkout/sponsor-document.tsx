import { getFormatter, getTranslations } from 'next-intl/server';
import QRCode from 'qrcode';
import { KorumLogo } from '@/components/brand/korum-logo';
import { CurrencyText } from '@/components/ui/currency-text';
import { formatCents } from '@/core/finance/money';
import type { Locale } from '@/i18n/routing';
import type { SponsorDocumentKind } from '@/lib/seo/portal-routes';
import type { SponsorshipDocuments } from '@/repositories/sponsorship.repository';
import { PrintButton } from './print-button';

/**
 * Justificante y factura de un patrocinio (Sprint 3.5, QA-F05), en una hoja limpia para imprimir o guardar. El **justificante** acredita que el
 * 100 % del nivel llega íntegro a la entidad; la **factura** es la de KORUM por su gestión publicitaria (fee + IVA), registrada en Veri*factu: son dos
 * documentos distintos y nunca se mezclan los importes. El CIF o NIF ya viene descifrado, solo para quien tiene el enlace firmado de su pedido.
 */

interface Props {
  kind: SponsorDocumentKind;
  locale: Locale;
  documents: SponsorshipDocuments;
  /** CIF o NIF del comercio, descifrado en servidor. */
  taxId: string;
  /** Razón social del emisor (`invoicing.issuerName` de la consola), si está configurada. */
  issuerName?: string;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 border-b border-patio-rule py-2 sm:grid-cols-[12rem_1fr] sm:gap-3">
      <dt className="text-sm font-bold text-ink-soft">{label}</dt>
      <dd className="font-semibold text-ink wrap-anywhere">{children}</dd>
    </div>
  );
}

export async function SponsorDocument({ kind, locale, documents, taxId, issuerName }: Props) {
  const t = await getTranslations({ locale, namespace: 'portal.sponsorDocs' });
  const format = await getFormatter({ locale });
  const { sponsor } = documents;
  const invoice = sponsor?.invoices[0] ?? null;
  const date = (value: Date) => format.dateTime(value, { dateStyle: 'long', timeZone: 'Europe/Madrid' });
  const returned = documents.status !== 'COMPLETED';
  const qrSvg = kind === 'factura' && invoice ? await QRCode.toString(invoice.verifactuQrUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 }) : null;

  return (
    <article className="korum-trust-vault mx-auto max-w-2xl space-y-4 p-6 print:border-0 print:shadow-none" aria-labelledby="document-title" data-testid={`sponsor-${kind}`}>
      <header className="flex items-center justify-between gap-3 border-b-2 border-varsity-navy pb-3">
        <KorumLogo size={40} />
        <p className="text-end text-sm font-bold text-ink-soft">{t('platform')}</p>
      </header>
      <h1 id="document-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
        {t(`${kind}.title`)}
      </h1>
      {returned ? (
        <p role="status" className="rounded-xl bg-amber-100 p-3 font-bold text-amber-950">
          {t('returned')}
        </p>
      ) : null}

      {kind === 'justificante' ? (
        <>
          <dl>
            <Row label={t('justificante.sponsor')}>{sponsor?.name}</Row>
            <Row label={t('justificante.taxId')}>
              <span className="font-mono">{taxId}</span>
            </Row>
            <Row label={t('justificante.recipient')}>{documents.organization.legalName}</Row>
            <Row label={t('justificante.initiative')}>{documents.initiative.title}</Row>
            <Row label={t('justificante.destination')}>{sponsor?.isMatchingPool ? t('justificante.pool') : t('justificante.escrow')}</Row>
            <Row label={t('justificante.category')}>{t(`level.${sponsor?.categoryLevel ?? 'PLATA'}`)}</Row>
            <Row label={t('justificante.amount')}>
              <CurrencyText cents={documents.amountCents} className="font-corp text-lg font-extrabold text-varsity-navy" />
            </Row>
            <Row label={t('justificante.date')}>{date(documents.createdAt)}</Row>
          </dl>
          <p className="rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-950">{t('justificante.whole', { amount: formatCents(documents.amountCents, locale) })}</p>
          <p className="text-sm text-ink-soft">{t('justificante.notInvoice')}</p>
        </>
      ) : invoice ? (
        <>
          <dl>
            <Row label={t('factura.number')}>
              <span className="font-mono" data-testid="invoice-number">
                {invoice.invoiceNumber}
              </span>
            </Row>
            <Row label={t('factura.date')}>{date(invoice.issuedAt)}</Row>
            <Row label={t('factura.issuer')}>{issuerName ?? t('factura.issuerFallback')}</Row>
            <Row label={t('factura.issuerTaxId')}>
              <span className="font-mono">{invoice.issuerTaxId}</span>
            </Row>
            <Row label={t('factura.recipient')}>{sponsor?.name}</Row>
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
            {qrSvg ? <div aria-hidden="true" className="size-28 shrink-0 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: qrSvg }} /> : null}
            <div className="min-w-0 space-y-1 text-sm">
              <p className="font-bold text-varsity-navy">{t('factura.verifactu')}</p>
              <p className="break-all font-mono text-xs text-ink-soft">{invoice.verifactuHash.slice(0, 16)}</p>
              <a href={invoice.verifactuQrUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-bold text-sky-800 underline print:hidden">
                {t('factura.verify')}
              </a>
            </div>
          </div>
        </>
      ) : (
        <p role="status" className="rounded-xl bg-patio-cream p-4 text-ink">
          {t('factura.none')}
        </p>
      )}

      <PrintButton label={t('print')} />
    </article>
  );
}
