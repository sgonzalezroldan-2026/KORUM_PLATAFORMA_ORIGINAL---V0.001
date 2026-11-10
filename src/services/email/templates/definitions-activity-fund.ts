import { z } from 'zod';
import type { EmailContent, TemplateContext, TemplateDefinition } from './email-content';

/**
 * Fondo de actividades de la entidad (Sprint 4.2f). Al comercio, sin datos de nadie: su aportación ha pasado a la entidad para sus actividades. A quienes
 * firman, **sin el nombre del comercio** (un email puede reenviarse): importes y fechas, y el botón a su panel, donde lo ven con su sesión.
 *
 * - `sponsor.toEntityFund`: al comercio, cuando su bolsa vence sin campaña.
 * - `activityFund.received`: a quienes firman, al entrar dinero en el Fondo, con la fecha límite para liquidarlo.
 * - `activityFund.reminder`: a quienes firman, cuando faltan `FUND_REMINDER_DAYS` días o menos para esa fecha.
 * - `activityFund.paid`: a quienes firman, cuando el dinero ya se ha enviado a la cuenta de la entidad (con el justificante en el panel).
 * - `sponsor.awaitingDecision`: a quienes firman, cuando un comercio cobrado espera su decisión con la campaña ya fuera de juego (su plazo corre).
 * - `sponsor.lateReceived`: al comercio cuyo pago llegó con la campaña ya cerrada: la entidad decidirá; qué pasa en cada caso.
 */

function organizationOf(context: TemplateContext, template: string): NonNullable<TemplateContext['organization']> {
  if (!context.organization) throw new Error(`La plantilla ${template} necesita una entidad.`);
  return context.organization;
}

const cents = z.number().int().positive();
const fundUrl = (context: TemplateContext, slug: string) => context.url(`/panel/${slug}/fondo`);

const toEntityFundPayload = z.object({ sponsorId: z.number().int().positive(), amountCents: cents });
export const sponsorToEntityFund: TemplateDefinition<z.infer<typeof toEntityFundPayload>> = {
  schema: toEntityFundPayload,
  needs: 'organization',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'sponsor.toEntityFund');
    const amount = context.formatMoney(payload.amountCents);
    return {
      subject: t('sponsor.toEntityFund.subject', { organization: organization.name }),
      preheader: t('sponsor.toEntityFund.preheader'),
      title: t('sponsor.toEntityFund.title'),
      paragraphs: [t('sponsor.toEntityFund.body', { organization: organization.name, amount }), t('sponsor.toEntityFund.why')],
      facts: [{ label: t('sponsor.renewalNotice.amount'), value: amount }],
      button: { label: t('sponsor.reassigned.cta'), url: context.url(`/${organization.slug}/comercios`) },
      footer: 'transactional'
    };
  }
};

const latePayload = z.object({ sponsorId: z.number().int().positive(), amountCents: cents });
export const sponsorLateReceived: TemplateDefinition<z.infer<typeof latePayload>> = {
  schema: latePayload,
  needs: 'organization',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'sponsor.lateReceived');
    const amount = context.formatMoney(payload.amountCents);
    return {
      subject: t('sponsor.lateReceived.subject', { organization: organization.name }),
      preheader: t('sponsor.lateReceived.preheader'),
      title: t('sponsor.lateReceived.title'),
      paragraphs: [t('sponsor.lateReceived.body', { organization: organization.name, amount }), t('sponsor.lateReceived.next', { organization: organization.name })],
      facts: [{ label: t('sponsor.renewalNotice.amount'), value: amount }],
      button: { label: t('sponsor.reassigned.cta'), url: context.url(`/${organization.slug}/comercios`) },
      footer: 'transactional'
    };
  }
};

const receivedPayload = z.object({ amountCents: cents, deadline: z.iso.datetime() });
export const activityFundReceived: TemplateDefinition<z.infer<typeof receivedPayload>> = {
  schema: receivedPayload,
  needs: 'organization',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'activityFund.received');
    const amount = context.formatMoney(payload.amountCents);
    const deadline = context.formatDate(payload.deadline);
    return {
      subject: t('activityFund.received.subject', { organization: organization.name, amount }),
      preheader: t('activityFund.received.preheader'),
      title: t('activityFund.received.title'),
      paragraphs: [t('activityFund.received.body', { amount, deadline }), t('activityFund.how')],
      facts: [
        { label: t('activityFund.amount'), value: amount },
        { label: t('activityFund.deadline'), value: deadline }
      ],
      button: { label: t('activityFund.cta'), url: fundUrl(context, organization.slug) },
      footer: 'organization'
    };
  }
};

export const activityFundReminder: TemplateDefinition<z.infer<typeof receivedPayload>> = {
  schema: receivedPayload,
  needs: 'organization',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'activityFund.reminder');
    const amount = context.formatMoney(payload.amountCents);
    const deadline = context.formatDate(payload.deadline);
    return {
      subject: t('activityFund.reminder.subject', { organization: organization.name, deadline }),
      preheader: t('activityFund.reminder.preheader'),
      title: t('activityFund.reminder.title'),
      paragraphs: [t('activityFund.reminder.body', { amount, deadline }), t('activityFund.how')],
      facts: [
        { label: t('activityFund.amount'), value: amount },
        { label: t('activityFund.deadline'), value: deadline }
      ],
      button: { label: t('activityFund.cta'), url: fundUrl(context, organization.slug) },
      footnote: t('activityFund.reminder.footnote'),
      footer: 'organization'
    };
  }
};

const paidPayload = z.object({ payoutId: z.number().int().positive(), amountCents: cents });
export const activityFundPaid: TemplateDefinition<z.infer<typeof paidPayload>> = {
  schema: paidPayload,
  needs: 'organization',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'activityFund.paid');
    const amount = context.formatMoney(payload.amountCents);
    return {
      subject: t('activityFund.paid.subject', { organization: organization.name, amount }),
      preheader: t('activityFund.paid.preheader'),
      title: t('activityFund.paid.title'),
      paragraphs: [t('activityFund.paid.body', { amount, reference: `FA-${payload.payoutId}` }), t('activityFund.paid.receipt')],
      facts: [
        { label: t('activityFund.amount'), value: amount },
        { label: t('activityFund.paid.reference'), value: `FA-${payload.payoutId}` }
      ],
      button: { label: t('activityFund.paid.cta'), url: fundUrl(context, organization.slug) },
      footer: 'organization'
    };
  }
};

const awaitingPayload = z.object({ sponsorId: z.number().int().positive(), amountCents: cents, deadline: z.iso.datetime() });
export const sponsorAwaitingDecision: TemplateDefinition<z.infer<typeof awaitingPayload>> = {
  schema: awaitingPayload,
  needs: 'organization',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'sponsor.awaitingDecision');
    const amount = context.formatMoney(payload.amountCents);
    const deadline = context.formatDate(payload.deadline);
    return {
      subject: t('sponsor.awaitingDecision.subject', { organization: organization.name }),
      preheader: t('sponsor.awaitingDecision.preheader'),
      title: t('sponsor.awaitingDecision.title'),
      paragraphs: [t('sponsor.awaitingDecision.body', { amount, deadline }), t('sponsor.awaitingDecision.what')],
      facts: [
        { label: t('activityFund.amount'), value: amount },
        { label: t('sponsor.awaitingDecision.deadline'), value: deadline }
      ],
      button: { label: t('sponsor.awaitingDecision.cta'), url: context.url(`/panel/${organization.slug}/aprobaciones#comercios`) },
      footer: 'organization'
    };
  }
};
