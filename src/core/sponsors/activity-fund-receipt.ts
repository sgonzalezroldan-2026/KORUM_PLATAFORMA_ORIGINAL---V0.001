import { formatCents } from '@/core/finance/money';
import { renderLinesPdf, wrapPdfText, type PdfLine } from '@/core/pdf/text-pdf';

/**
 * Justificante de una liquidación del Fondo de actividades (Sprint 4.2f, decisión del promotor del 2026-11-10: «destino + PDF»). Dice de qué comercios
 * salió el dinero, para qué lo usará la entidad (lo que firmaron las dos personas), quién firmó y cuándo se envió. Sin datos de contacto ni CIF de los
 * comercios. Los textos llegan ya traducidos a través de `t` (`panel.fund.receipt.*`); aquí solo hay maquetación.
 */

export type FundReceiptTranslator = (key: string, values?: Record<string, string>) => string;

export interface FundReceiptData {
  reference: string;
  entityName: string;
  legalName: string;
  amountCents: number;
  purpose: string;
  requestedAt: Date;
  executedAt: Date;
  sponsors: ReadonlyArray<{ name: string; level: string; amountCents: number; chargedAt: Date }>;
  signatures: ReadonlyArray<{ role: string; name: string; signedAt: Date }>;
  generatedAt: Date;
  locale: 'es' | 'ca' | 'en';
}

export function buildFundReceiptLines(data: FundReceiptData, t: FundReceiptTranslator): PdfLine[] {
  const money = (cents: number) => formatCents(cents, data.locale);
  const day = (value: Date) => new Intl.DateTimeFormat(data.locale, { dateStyle: 'long', timeZone: 'Europe/Madrid' }).format(value);
  const moment = (value: Date) => new Intl.DateTimeFormat(data.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' }).format(value);
  const lines: PdfLine[] = [{ style: 'title', text: t('title') }];
  const paragraph = (text: string) => {
    for (const line of wrapPdfText(text)) lines.push({ style: 'body', text: line });
    lines.push({ style: 'body', text: '' });
  };
  paragraph(t('intro', { entity: data.entityName, legalName: data.legalName }));

  lines.push({ style: 'heading', text: t('sections.payout') });
  lines.push({ style: 'body', text: `${t('reference')}: ${data.reference}` });
  lines.push({ style: 'body', text: `${t('amount')}: ${money(data.amountCents)}` });
  lines.push({ style: 'body', text: `${t('requestedAt')}: ${day(data.requestedAt)}` });
  lines.push({ style: 'body', text: `${t('executedAt')}: ${day(data.executedAt)}` });
  lines.push({ style: 'body', text: '' });

  lines.push({ style: 'heading', text: t('sections.purpose') });
  for (const block of data.purpose.split(/\r?\n/)) paragraph(block);

  lines.push({ style: 'heading', text: t('sections.origin') });
  paragraph(t('originIntro'));
  for (const sponsor of data.sponsors) {
    for (const line of wrapPdfText(`- ${t('originLine', { name: sponsor.name, level: sponsor.level, amount: money(sponsor.amountCents), charged: day(sponsor.chargedAt) })}`)) lines.push({ style: 'body', text: line });
  }
  lines.push({ style: 'body', text: '' });

  lines.push({ style: 'heading', text: t('sections.signatures') });
  for (const signature of data.signatures) lines.push({ style: 'body', text: `- ${t('signatureLine', { role: signature.role, name: signature.name, date: moment(signature.signedAt) })}` });
  lines.push({ style: 'body', text: '' });

  lines.push({ style: 'heading', text: t('sections.notes') });
  paragraph(t('legal'));
  lines.push({ style: 'body', text: t('generated', { date: moment(data.generatedAt) }) });
  return lines;
}

export function renderFundReceiptPdf(data: FundReceiptData, t: FundReceiptTranslator): Uint8Array {
  return renderLinesPdf(buildFundReceiptLines(data, t));
}
