import { z } from 'zod';
import { HUCHA_PATH } from '@/lib/seo/portal-routes';
import type { EmailContent, TemplateContext, TemplateDefinition } from './email-content';

/**
 * Emails de la aportación mensual de Mi Hucha (`PLEDGE`, Sprint 3.8, EXPERIENCIA_DE_PRODUCTO §4): a qué campaña ha ido el mes, el mes sin
 * campaña que no se ha cobrado y el cobro rechazado. Siempre con el enlace para pausar o cambiar. Nunca hablan de un saldo: no existe.
 */

const centsSchema = z.number().int().nonnegative();
const cycleSchema = z.number().int().positive();

function organizationOf(context: TemplateContext, template: string): NonNullable<TemplateContext['organization']> {
  if (!context.organization) throw new Error(`La plantilla ${template} necesita una entidad.`);
  return context.organization;
}

const chargedPayload = z.object({
  initiativeId: z.number().int().positive(),
  amountCents: centsSchema,
  feeCents: centsSchema,
  totalCents: centsSchema,
  reference: z.string().min(1).max(64),
  cycle: cycleSchema,
  totalMonths: cycleSchema,
  fiscalCertificate: z.boolean()
});

export const pledgeCharged: TemplateDefinition<z.infer<typeof chargedPayload>> = {
  schema: chargedPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'pledge.charged');
    if (!context.initiative) throw new Error('La plantilla pledge.charged necesita una iniciativa.');
    const initiative = context.initiative;
    return {
      subject: t('pledge.charged.subject', { organization: organization.name }),
      preheader: t('pledge.charged.preheader', { initiative: initiative.title }),
      title: t('pledge.charged.title'),
      paragraphs: [
        t('pledge.charged.body', { amount: context.formatMoney(payload.amountCents), initiative: initiative.title, organization: organization.name }),
        t('receipt.guarantee'),
        t(payload.fiscalCertificate ? 'pledge.charged.fiscalCertificate' : 'receipt.fiscalReceipt')
      ],
      facts: [
        { label: t('pledge.month'), value: t('pledge.monthValue', { cycle: payload.cycle, total: payload.totalMonths }) },
        { label: t('receipt.contribution'), value: context.formatMoney(payload.amountCents) },
        { label: t('pledge.fee'), value: context.formatMoney(payload.feeCents) },
        { label: t('receipt.total'), value: context.formatMoney(payload.totalCents) },
        { label: t('receipt.holder'), value: organization.legalName },
        { label: t('receipt.reference'), value: payload.reference }
      ],
      button: { label: t('pledge.cta'), url: context.url(HUCHA_PATH) },
      footer: 'transactional'
    };
  }
};

/** `last`: era el último mes, así que no habrá «mes que viene». */
const skippedPayload = z.object({ amountCents: centsSchema, cycle: cycleSchema, totalMonths: cycleSchema, last: z.boolean().default(false) });

export const pledgeSkipped: TemplateDefinition<z.infer<typeof skippedPayload>> = {
  schema: skippedPayload,
  needs: 'organization',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'pledge.skipped');
    return {
      subject: t('pledge.skipped.subject', { organization: organization.name }),
      preheader: t('pledge.skipped.preheader'),
      title: t('pledge.skipped.title'),
      paragraphs: [t('pledge.skipped.body', { organization: organization.name, amount: context.formatMoney(payload.amountCents) }), t(payload.last ? 'pledge.skipped.last' : 'pledge.skipped.next')],
      facts: [{ label: t('pledge.month'), value: t('pledge.monthValue', { cycle: payload.cycle, total: payload.totalMonths }) }],
      button: { label: t('pledge.cta'), url: context.url(HUCHA_PATH) },
      footer: 'transactional'
    };
  }
};

const failedPayload = z.object({ amountCents: centsSchema, cycle: cycleSchema, reason: z.enum(['CHARGE_FAILED', 'CARD_UNAVAILABLE']) });

export const pledgeFailed: TemplateDefinition<z.infer<typeof failedPayload>> = {
  schema: failedPayload,
  needs: 'organization',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'pledge.failed');
    return {
      subject: t('pledge.failed.subject', { organization: organization.name }),
      preheader: t('pledge.failed.preheader'),
      title: t('pledge.failed.title'),
      paragraphs: [
        t('pledge.failed.body', { organization: organization.name, amount: context.formatMoney(payload.amountCents) }),
        t(payload.reason === 'CARD_UNAVAILABLE' ? 'pledge.failed.cardGone' : 'pledge.failed.paused')
      ],
      facts: [],
      button: { label: t('pledge.cta'), url: context.url(HUCHA_PATH) },
      footer: 'transactional'
    };
  }
};
