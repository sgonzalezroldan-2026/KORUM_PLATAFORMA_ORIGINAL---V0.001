import { formatCents } from '@/core/finance/money';
import { renderLinesPdf, wrapPdfText, type PdfLine } from '@/core/pdf/text-pdf';

/**
 * Informe de impacto y transparencia del kit de medallas (Sprint 4.1). Solo cifras reales de la entidad: las campañas conseguidas del curso
 * y lo recaudado en ellas salen de la base de datos, nunca de una estimación. Los textos llegan ya traducidos a través de `t`
 * (`panel.medals.report.*`); aquí solo hay maquetación.
 */

export type MedalReportTranslator = (key: string, values?: Record<string, string>) => string;

export interface MedalReportData {
  entityName: string;
  period: string;
  tierName: string;
  completedCampaigns: number;
  totalRaisedCents: number;
  activeSponsors: number;
  achievements: ReadonlyArray<{ title: string; raisedCents: number }>;
  generatedAt: Date;
  locale: 'es' | 'ca' | 'en';
}

export function buildMedalReportLines(data: MedalReportData, t: MedalReportTranslator): PdfLine[] {
  const money = (cents: number) => formatCents(cents, data.locale);
  const date = new Intl.DateTimeFormat(data.locale, { dateStyle: 'long', timeZone: 'Europe/Madrid' }).format(data.generatedAt);
  const lines: PdfLine[] = [{ style: 'title', text: t('title', { tier: data.tierName }) }];
  const paragraph = (text: string) => {
    for (const line of wrapPdfText(text)) lines.push({ style: 'body', text: line });
    lines.push({ style: 'body', text: '' });
  };
  paragraph(t('intro', { entity: data.entityName, period: data.period, tier: data.tierName }));

  lines.push({ style: 'heading', text: t('sections.impact') });
  lines.push({ style: 'body', text: `• ${t('impact.campaigns', { count: String(data.completedCampaigns) })}` });
  lines.push({ style: 'body', text: `• ${t('impact.raised', { amount: money(data.totalRaisedCents) })}` });
  lines.push({ style: 'body', text: `• ${t('impact.sponsors', { count: String(data.activeSponsors) })}` });
  lines.push({ style: 'body', text: '' });

  lines.push({ style: 'heading', text: t('sections.achievements') });
  if (data.achievements.length === 0) paragraph(t('achievementsEmpty'));
  for (const achievement of data.achievements) {
    for (const line of wrapPdfText(`• ${achievement.title}: ${money(achievement.raisedCents)}`)) lines.push({ style: 'body', text: line });
  }
  if (data.achievements.length > 0) lines.push({ style: 'body', text: '' });

  lines.push({ style: 'heading', text: t('sections.transparency') });
  paragraph(t('transparency.retained'));
  paragraph(t('transparency.refund'));
  paragraph(t('transparency.independence'));
  lines.push({ style: 'body', text: t('generatedAt', { date }) });
  return lines;
}

export function renderMedalReportPdf(data: MedalReportData, t: MedalReportTranslator): Uint8Array {
  return renderLinesPdf(buildMedalReportLines(data, t));
}
