import { z } from 'zod';
import { legalPathOf } from '@/core/legal/legal-catalog';
import type { EmailContent, TemplateDefinition } from './email-content';

/**
 * Aviso de cambio de los textos que acepta una entidad (Sprint 5.10a, decisión 54; contrato de encargo, cláusulas 10 y 17; condiciones para entidades §17): al
 * publicarse una versión nueva de las condiciones para entidades o del contrato de encargo (también si solo cambia la lista de proveedores), quienes firman
 * reciben este email con la fecha desde la que se les aplica (30 días después; al momento si es un cambio urgente de proveedor, decisión 58). Lo escribe
 * KORUM, no la entidad.
 */

const payload = z.object({
  document: z.enum(['condiciones-entidades', 'contrato-de-encargo']),
  version: z.string().min(10).max(20),
  effectiveAt: z.string().datetime(),
  /** Cambio urgente de proveedor (decisión 58): se aplica desde hoy. */
  urgent: z.boolean().optional(),
  /** Qué cambia, en palabras del Super-Admin (RGPD, art. 28.2: un cambio de proveedor se identifica para poder oponerse). */
  changeSummary: z.string().min(1).max(500).optional()
});

export const legalChangeNotice: TemplateDefinition<z.infer<typeof payload>> = {
  schema: payload,
  needs: 'organization',
  sender: 'platform',
  build: (input, { t, url, formatDate, organization }): EmailContent => {
    const date = formatDate(input.effectiveAt);
    const values = { organization: organization?.name ?? '', date, document: t(`legal.changeNotice.document.${input.document}`) };
    return {
      subject: t(`legal.changeNotice.subject.${input.document}`),
      preheader: t('legal.changeNotice.preheader', values),
      title: t(`legal.changeNotice.subject.${input.document}`),
      paragraphs: [
        t(input.urgent ? 'legal.changeNotice.urgentBody' : 'legal.changeNotice.body', values),
        ...(input.changeSummary ? [t('legal.changeNotice.summary', { summary: input.changeSummary })] : []),
        // Condiciones para entidades §17: un cambio no afecta a lo ya publicado.
        ...(input.document === 'condiciones-entidades' ? [t('legal.changeNotice.campaigns')] : []),
        t(input.urgent ? 'legal.changeNotice.urgentOptions' : 'legal.changeNotice.options')
      ],
      facts: [
        { label: t('legal.changeNotice.version'), value: input.version },
        { label: t('legal.changeNotice.effective'), value: date }
      ],
      button: { label: t('legal.changeNotice.cta'), url: url(legalPathOf(input.document)) },
      footnote: t('legal.changeNotice.footnote'),
      footer: 'organization'
    };
  }
};
