import { z } from 'zod';
import { sponsorDocumentPath, sponsorRenewalPath, type SponsorDocumentKind } from '@/lib/seo/portal-routes';
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

/*
 * Renovación y reasignación (Sprint 4.2d). El enlace de la renovación (`token`) es secreto: abre la página de pago de la renovación de ese comercio.
 * `expiresAt` es hasta cuándo vale (la bandeja no envía uno caducado) y `badgeExpiresAt`, cuándo vence el distintivo.
 */

const renewalToken = z.string().regex(/^[1-9]\d{0,9}\.\d{10,13}\.[0-9a-f]{64}$/);
const renewalLinkPayload = z.object({
  sponsorId: z.number().int().positive(),
  amountCents: z.number().int().positive(),
  badgeExpiresAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  token: renewalToken
});
type RenewalLinkPayload = z.infer<typeof renewalLinkPayload>;

const renewalUrl = (context: TemplateContext, slug: string, token: string) => context.url(`${sponsorRenewalPath(slug)}?${new URLSearchParams({ r: token }).toString()}`);

function renewalEmail(key: 'renewalNotice' | 'renewalLink'): TemplateDefinition<RenewalLinkPayload> {
  return {
    schema: renewalLinkPayload,
    secretFields: ['token'],
    needs: 'organization',
    build(payload, context): EmailContent {
      const { t } = context;
      const organization = organizationOf(context, `sponsor.${key}`);
      const date = context.formatDate(payload.badgeExpiresAt);
      const until = context.formatDate(payload.expiresAt);
      const amount = context.formatMoney(payload.amountCents);
      return {
        subject: t(`sponsor.${key}.subject`, { organization: organization.name, date }),
        preheader: t(`sponsor.${key}.preheader`),
        title: t(`sponsor.${key}.title`),
        paragraphs: [t(`sponsor.${key}.body`, { organization: organization.name, date, amount, until })],
        facts: [
          { label: t(`sponsor.${key}.amount`), value: amount },
          { label: t(`sponsor.${key}.date`), value: key === 'renewalNotice' ? date : until }
        ],
        // Sin cobro automático: el enlace lleva a la renovación, que se paga en la página de Paycomet.
        button: { label: t(`sponsor.${key}.cta`), url: renewalUrl(context, organization.slug, payload.token) },
        footnote: t('sponsor.renewal.footnote'),
        footer: 'transactional'
      };
    }
  };
}

export const sponsorRenewalNotice = renewalEmail('renewalNotice');
export const sponsorRenewalLink = renewalEmail('renewalLink');

const titles = z.array(z.string().min(1).max(200)).min(1).max(5);
/** «A, B y 2 más»: los títulos de las campañas que han recibido el dinero (como mucho 5 en el mensaje). */
const campaignList = (context: TemplateContext, names: readonly string[], more: number) =>
  more > 0 ? context.t('sponsor.reassigned.listMore', { list: names.join(', '), more }) : names.join(', ');

const renewedPayload = z.object({
  sponsorId: z.number().int().positive(),
  level: z.enum(['ORO', 'PLATA', 'BRONCE']),
  amountCents: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
  placed: titles.optional(),
  more: z.number().int().min(0).max(1_000).optional(),
  poolDeadline: z.iso.datetime().optional(),
  manual: z.boolean().optional(),
  order: z
    .string()
    .regex(/^KR[0-9A-F]{16}$/)
    .optional(),
  sig: sig.optional()
});
export const sponsorRenewed: TemplateDefinition<z.infer<typeof renewedPayload>> = {
  schema: renewedPayload,
  secretFields: ['sig'],
  needs: 'organization',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'sponsor.renewed');
    const date = context.formatDate(payload.expiresAt);
    const amount = context.formatMoney(payload.amountCents);
    const level = t(`sponsor.level.${payload.level}`);
    const destination = payload.placed
      ? t('sponsor.renewed.placed', { amount, list: campaignList(context, payload.placed, payload.more ?? 0) })
      : payload.poolDeadline
        ? t(payload.manual ? 'sponsor.creditPool.bodyManual' : 'sponsor.creditPool.bodyWaiting', { amount, deadline: context.formatDate(payload.poolDeadline), organization: organization.name })
        : null;
    return {
      subject: t('sponsor.renewed.subject', { organization: organization.name }),
      preheader: t('sponsor.renewed.preheader'),
      title: t('sponsor.renewed.title'),
      paragraphs: [t('sponsor.renewed.body', { organization: organization.name, level, date }), ...(destination ? [destination] : [])],
      facts: [
        { label: t('sponsor.welcome.levelLabel'), value: level },
        { label: t('sponsor.welcome.until'), value: date }
      ],
      // Al justificante y la factura de la renovación, con la firma de su pedido; sin ella (no debería faltar), al directorio.
      button:
        payload.order && payload.sig
          ? { label: t('sponsor.welcome.cta'), url: documentUrl(context, organization.slug, 'justificante', { order: payload.order, sig: payload.sig }) }
          : { label: t('sponsor.reassigned.cta'), url: context.url(`/${organization.slug}/comercios`) },
      footer: 'transactional'
    };
  }
};

const reassignedPayload = z.object({ sponsorId: z.number().int().positive(), amountCents: z.number().int().positive(), titles, more: z.number().int().min(0).max(1_000) });
export const sponsorReassigned: TemplateDefinition<z.infer<typeof reassignedPayload>> = {
  schema: reassignedPayload,
  needs: 'organization',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'sponsor.reassigned');
    const amount = context.formatMoney(payload.amountCents);
    return {
      subject: t('sponsor.reassigned.subject', { organization: organization.name }),
      preheader: t('sponsor.reassigned.preheader'),
      title: t('sponsor.reassigned.title'),
      paragraphs: [t('sponsor.reassigned.body', { organization: organization.name, amount, list: campaignList(context, payload.titles, payload.more) }), t('sponsor.reassigned.why')],
      facts: [{ label: t('sponsor.renewalNotice.amount'), value: amount }],
      button: { label: t('sponsor.reassigned.cta'), url: context.url(`/${organization.slug}/comercios`) },
      footer: 'transactional'
    };
  }
};

const creditPoolPayload = z.object({ sponsorId: z.number().int().positive(), amountCents: z.number().int().positive(), deadline: z.iso.datetime(), manual: z.boolean() });
export const sponsorCreditPool: TemplateDefinition<z.infer<typeof creditPoolPayload>> = {
  schema: creditPoolPayload,
  needs: 'organization',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'sponsor.creditPool');
    const amount = context.formatMoney(payload.amountCents);
    const deadline = context.formatDate(payload.deadline);
    return {
      subject: t('sponsor.creditPool.subject', { organization: organization.name }),
      preheader: t('sponsor.creditPool.preheader'),
      title: t('sponsor.creditPool.title'),
      paragraphs: [t(payload.manual ? 'sponsor.creditPool.bodyManual' : 'sponsor.creditPool.bodyWaiting', { organization: organization.name, amount, deadline }), t('sponsor.creditPool.visible')],
      facts: [
        { label: t('sponsor.renewalNotice.amount'), value: amount },
        { label: t('sponsor.creditPool.deadline'), value: deadline }
      ],
      button: { label: t('sponsor.reassigned.cta'), url: context.url(`/${organization.slug}/comercios`) },
      footer: 'transactional'
    };
  }
};
