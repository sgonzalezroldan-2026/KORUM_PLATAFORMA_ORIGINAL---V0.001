import { z } from 'zod';
import type { EmailContent, TemplateContext, TemplateDefinition } from './email-content';

/**
 * Avisos del buzón de ideas (Sprint 4.2a). `idea.quorumReached`: a quienes firman por la entidad cuando una idea alcanza el quórum, para que
 * no se quede esperando la doble firma sin que nadie lo sepa. `idea.centerReplied`: a quien propuso la idea cuando la entidad la publica (y si
 * corrigió su texto), le responde o la desestima, **sin el texto** (un email puede reenviarse o leerse en una pantalla ajena): lo lee en *Mi cuenta* con su sesión.
 */

function organizationOf(context: TemplateContext, template: string): NonNullable<TemplateContext['organization']> {
  if (!context.organization) throw new Error(`La plantilla ${template} necesita una entidad.`);
  return context.organization;
}

const alias = z.string().regex(/^#FAM-\d{4}$/);

const quorumPayload = z.object({ ideaId: z.number().int().positive(), alias, ideaTitle: z.string().min(1).max(200) });
export const ideaQuorumReached: TemplateDefinition<z.infer<typeof quorumPayload>> = {
  schema: quorumPayload,
  needs: 'organization',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'idea.quorumReached');
    return {
      subject: t('idea.quorumReached.subject', { title: payload.ideaTitle }),
      preheader: t('idea.quorumReached.preheader'),
      title: t('idea.quorumReached.title'),
      paragraphs: [t('idea.quorumReached.body', { title: payload.ideaTitle, alias: payload.alias }), t('idea.quorumReached.next')],
      facts: [],
      button: { label: t('idea.quorumReached.cta'), url: context.url(`/panel/${organization.slug}/aprobaciones`) },
      footer: 'organization'
    };
  }
};

const repliedPayload = z.object({ ideaId: z.number().int().positive(), alias, kind: z.enum(['REPLY', 'REJECTED', 'APPROVED']), edited: z.boolean().optional() });
export const ideaCenterReplied: TemplateDefinition<z.infer<typeof repliedPayload>> = {
  schema: repliedPayload,
  needs: 'organization',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'idea.centerReplied');
    const kind = payload.kind === 'REJECTED' ? 'rejected' : payload.kind === 'APPROVED' ? 'approved' : 'reply';
    return {
      subject: t(`idea.centerReplied.${kind}.subject`, { organization: organization.name }),
      preheader: t(`idea.centerReplied.${kind}.preheader`),
      title: t(`idea.centerReplied.${kind}.title`),
      paragraphs: [t(`idea.centerReplied.${kind}.body`, { organization: organization.name, alias: payload.alias }), ...(payload.kind === 'APPROVED' && payload.edited ? [t('idea.centerReplied.approved.edited')] : [])],
      facts: [],
      button: { label: t('idea.centerReplied.cta'), url: context.url('/mi-cuenta/propuestas') },
      footnote: t('idea.centerReplied.footnote'),
      footer: 'transactional'
    };
  }
};
