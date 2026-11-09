import { z } from 'zod';
import { sponsorDocumentPath, type SponsorDocumentKind } from '@/lib/seo/portal-routes';
import type { EmailContent, TemplateContext, TemplateDefinition } from './email-content';

/**
 * Emails al comercio tras la decisión de la entidad (Sprint 4.2b). `sponsor.welcome`: aprobado, con un solo botón a sus documentos (el justificante,
 * desde el que se abren la factura y el cartel del escaparate; el cartel lleva su propia firma, porque es lo que se comparte). `sponsor.rejected`: no admitido, con el motivo que
 * escribió la entidad, la devolución del 100 % y, si había factura, su rectificativa. El enlace firmado es secreto: se borra del mensaje al enviarlo.
 */

function organizationOf(context: TemplateContext, template: string): NonNullable<TemplateContext['organization']> {
  if (!context.organization) throw new Error(`La plantilla ${template} necesita una entidad.`);
  return context.organization;
}

const order = z.string().regex(/^KS[0-9A-F]{16}$/);
const sig = z.string().regex(/^[0-9a-f]{64}$/);

const documentUrl = (context: TemplateContext, slug: string, kind: SponsorDocumentKind, payload: { order: string; sig: string }) =>
  context.url(`${sponsorDocumentPath(slug, kind)}?${new URLSearchParams({ pedido: payload.order, sig: payload.sig }).toString()}`);

const welcomePayload = z.object({ sponsorId: z.number().int().positive(), level: z.enum(['ORO', 'PLATA', 'BRONCE']), matching: z.boolean(), expiresAt: z.iso.datetime(), order, sig });
export const sponsorWelcome: TemplateDefinition<z.infer<typeof welcomePayload>> = {
  schema: welcomePayload,
  secretFields: ['sig'],
  needs: 'organization',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'sponsor.welcome');
    const date = context.formatDate(payload.expiresAt);
    const level = t(`sponsor.level.${payload.level}`);
    return {
      subject: t('sponsor.welcome.subject', { organization: organization.name }),
      preheader: t('sponsor.welcome.preheader'),
      title: t('sponsor.welcome.title'),
      paragraphs: [t('sponsor.welcome.body', { organization: organization.name, level, date }), ...(payload.matching ? [t('sponsor.welcome.matching')] : []), t('sponsor.welcome.documents')],
      facts: [
        { label: t('sponsor.welcome.levelLabel'), value: level },
        { label: t('sponsor.welcome.until'), value: date }
      ],
      // Al justificante, con la firma del pedido: desde ahí se abren la factura y el cartel (este con su propia firma, que es la que se comparte).
      button: { label: t('sponsor.welcome.cta'), url: documentUrl(context, organization.slug, 'justificante', payload) },
      footer: 'transactional'
    };
  }
};

const rejectedPayload = z.object({ sponsorId: z.number().int().positive(), reason: z.string().min(1).max(400), refundCents: z.number().int().positive(), rectified: z.boolean(), order, sig });
export const sponsorRejected: TemplateDefinition<z.infer<typeof rejectedPayload>> = {
  schema: rejectedPayload,
  secretFields: ['sig'],
  needs: 'organization',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'sponsor.rejected');
    const amount = context.formatMoney(payload.refundCents);
    return {
      subject: t('sponsor.rejected.subject', { organization: organization.name }),
      preheader: t('sponsor.rejected.preheader'),
      title: t('sponsor.rejected.title'),
      paragraphs: [
        t('sponsor.rejected.body', { organization: organization.name, amount }),
        t('sponsor.rejected.reason', { reason: payload.reason }),
        ...(payload.rectified ? [t('sponsor.rejected.rectified')] : [])
      ],
      facts: [{ label: t('sponsor.rejected.amount'), value: amount }],
      button: payload.rectified
        ? { label: t('sponsor.rejected.ctaRectified'), url: documentUrl(context, organization.slug, 'rectificativa', payload) }
        : { label: t('sponsor.rejected.cta'), url: documentUrl(context, organization.slug, 'justificante', payload) },
      footnote: t('sponsor.rejected.footnote'),
      footer: 'transactional'
    };
  }
};
