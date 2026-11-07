import { getFormatter, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { KorumLogo } from '@/components/brand/korum-logo';
import { PrintButton } from '@/components/checkout/print-button';
import { CurrencyText } from '@/components/ui/currency-text';
import type { DonationDocumentKind } from '@/core/tax/donation-document';
import type { Locale } from '@/i18n/routing';

/**
 * Certificado fiscal o justificante nominativo de una donación (Sprint 3.7), en una hoja limpia para imprimir o guardar en PDF desde el navegador.
 * Lleva la leyenda de **borrador** mientras la asesoría fiscal no revise su texto (tareas externas aplazadas del plan). La aportación voluntaria a
 * KORUM nunca aparece: no es un donativo a la entidad. El NIF ya viene descifrado, solo para la propia persona.
 */

export interface DonationDocumentData {
  kind: DonationDocumentKind;
  reference: string;
  organizationLegalName: string;
  organizationTaxId: string | null;
  donorFullName: string | null;
  donorTaxId: string | null;
  donorProvinceCode: string | null;
  initiativeTitle: string;
  amountCents: number;
  fiscalYear: number;
  donatedAt: Date;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 border-b border-patio-rule py-2 sm:grid-cols-[12rem_1fr] sm:gap-3">
      <dt className="text-sm font-bold text-ink-soft">{label}</dt>
      <dd className="font-semibold text-ink wrap-anywhere">{children}</dd>
    </div>
  );
}

export async function DonationDocumentView({ locale, document }: { locale: Locale; document: DonationDocumentData }) {
  const t = await getTranslations({ locale, namespace: 'account.documents.sheet' });
  const format = await getFormatter({ locale });
  const certificate = document.kind === 'TAX_CERTIFICATE';

  return (
    <article className="korum-trust-vault mx-auto max-w-2xl space-y-4 p-6 print:border-0 print:shadow-none" aria-labelledby="document-title" data-testid={`donation-${document.kind}`}>
      <header className="flex items-center justify-between gap-3 border-b-2 border-varsity-navy pb-3">
        <KorumLogo size={40} />
        <p className="text-end text-sm font-bold text-ink-soft">{t('platform')}</p>
      </header>
      <p className="rounded-xl border-2 border-amber-600 bg-amber-50 p-3 text-sm font-bold text-amber-950">{t('draft')}</p>
      <h1 id="document-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
        {t(certificate ? 'certificateTitle' : 'receiptTitle')}
      </h1>
      <dl>
        <Row label={t('reference')}>
          <span className="font-mono">{document.reference}</span>
        </Row>
        <Row label={t('recipient')}>{document.organizationLegalName}</Row>
        {document.organizationTaxId ? (
          <Row label={t('recipientTaxId')}>
            <span className="font-mono">{document.organizationTaxId}</span>
          </Row>
        ) : null}
        <Row label={t('donor')}>{document.donorFullName ?? t('donorUnknown')}</Row>
        {certificate && document.donorTaxId ? (
          <Row label={t('donorTaxId')}>
            <span className="font-mono">{document.donorTaxId}</span>
          </Row>
        ) : null}
        {certificate && document.donorProvinceCode ? <Row label={t('province')}>{document.donorProvinceCode}</Row> : null}
        <Row label={t('initiative')}>{document.initiativeTitle}</Row>
        <Row label={t('amount')}>
          <CurrencyText cents={document.amountCents} className="font-corp text-lg font-extrabold text-varsity-navy" />
        </Row>
        <Row label={t('date')}>{format.dateTime(document.donatedAt, { dateStyle: 'long', timeZone: 'Europe/Madrid' })}</Row>
        <Row label={t('fiscalYear')}>{document.fiscalYear}</Row>
      </dl>
      <p className="rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-950">{t(certificate ? 'certificateText' : 'receiptText')}</p>
      <p className="text-sm text-ink-soft">{t('guaranteeNote')}</p>
      <PrintButton label={t('print')} />
    </article>
  );
}
