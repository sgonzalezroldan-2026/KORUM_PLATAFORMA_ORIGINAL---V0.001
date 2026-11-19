import { z } from 'zod';
import { eventRefundPath } from '@/lib/seo/portal-routes';
import type { EmailContent, TemplateContext, TemplateDefinition } from './email-content';

/**
 * Eventos con entradas: llegada de la fecha, cancelación y cambio de fecha (Sprint 5.13, decisión 30 del promotor; EXPERIENCIA §4).
 *
 * A quienes firman:
 * - `event.dateReached`: el evento llegó a su fecha. Con algo vendido, ya se puede liquidar por lo vendido; sin nada, se ha cerrado sin dinero que mover.
 * - `event.changed`: una persona firmante lo ha cancelado o le ha cambiado la fecha. La otra se entera al momento.
 *
 * A quienes compraron (por lotes, una vez por persona; avisos sobre su propia compra, pie `transactional`):
 * - `event.cancelledBuyer`: el evento se cancela y se le devuelve el 100 % sin que tenga que hacer nada.
 * - `event.rescheduledBuyer`: el evento cambia de fecha; con su enlace personal (`refundToken`, campo secreto: se borra de la bandeja al enviarlo) puede
 *   recuperar el 100 % hasta el final de los 14 días. Si no lo pide, su entrada vale para la fecha nueva.
 *
 * Sin importes de nadie más ni nombres: el email puede reenviarse.
 */

function initiativeOf(context: TemplateContext, template: string): NonNullable<TemplateContext['initiative']> {
  if (!context.initiative) throw new Error(`La plantilla ${template} necesita una iniciativa.`);
  return context.initiative;
}

function organizationOf(context: TemplateContext, template: string): NonNullable<TemplateContext['organization']> {
  if (!context.organization) throw new Error(`La plantilla ${template} necesita una entidad.`);
  return context.organization;
}

const dateOf = (context: TemplateContext, iso: string) => context.formatDateTime(new Date(iso));

const dateReachedPayload = z.object({ initiativeId: z.number().int().positive(), walletEscrowId: z.string().max(40).nullish(), outcome: z.enum(['SETTLE', 'CLOSE_EMPTY']), ticketsSold: z.number().int().min(0), raisedCents: z.number().int().min(0) });
export const eventDateReached: TemplateDefinition<z.infer<typeof dateReachedPayload>> = {
  schema: dateReachedPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'event.dateReached');
    const organization = organizationOf(context, 'event.dateReached');
    const settle = payload.outcome === 'SETTLE';
    return {
      subject: t(settle ? 'event.dateReached.settleSubject' : 'event.dateReached.emptySubject', { initiative: initiative.title }),
      preheader: t(settle ? 'event.dateReached.settlePreheader' : 'event.dateReached.emptyPreheader'),
      title: t(settle ? 'event.dateReached.settleTitle' : 'event.dateReached.emptyTitle'),
      paragraphs: settle
        ? [t('event.dateReached.settleBody', { initiative: initiative.title, count: payload.ticketsSold }), t('event.dateReached.settleNext')]
        : [t('event.dateReached.emptyBody', { initiative: initiative.title })],
      facts: settle ? [{ label: t('event.dateReached.raised'), value: context.formatMoney(payload.raisedCents) }] : [],
      button: settle ? { label: t('event.dateReached.settleCta'), url: context.url(`/panel/${organization.slug}/liquidaciones`) } : { label: t('event.dateReached.emptyCta'), url: context.url(`/panel/${organization.slug}`) },
      footer: 'organization'
    };
  }
};

const changedPayload = z.object({
  initiativeId: z.number().int().positive(),
  change: z.enum(['CANCELLED', 'RESCHEDULED']),
  ticketsSold: z.number().int().min(0).optional(),
  newDate: z.string().datetime().optional(),
  refundUntil: z.string().datetime().optional()
});
export const eventChanged: TemplateDefinition<z.infer<typeof changedPayload>> = {
  schema: changedPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'event.changed');
    const organization = organizationOf(context, 'event.changed');
    const cancelled = payload.change === 'CANCELLED';
    return {
      subject: t(cancelled ? 'event.changed.cancelledSubject' : 'event.changed.rescheduledSubject', { initiative: initiative.title }),
      preheader: t(cancelled ? 'event.changed.cancelledPreheader' : 'event.changed.rescheduledPreheader'),
      title: t(cancelled ? 'event.changed.cancelledTitle' : 'event.changed.rescheduledTitle'),
      paragraphs: cancelled
        ? [t('event.changed.cancelledBody', { initiative: initiative.title, count: payload.ticketsSold ?? 0 })]
        : [
            t('event.changed.rescheduledBody', { initiative: initiative.title, date: payload.newDate ? dateOf(context, payload.newDate) : '' }),
            t('event.changed.rescheduledRefund', { until: payload.refundUntil ? dateOf(context, payload.refundUntil) : '' })
          ],
      facts: [],
      button: { label: t('event.changed.cta'), url: context.url(`/panel/${organization.slug}/taquilla`) },
      footer: 'organization'
    };
  }
};

const cancelledBuyerPayload = z.object({ initiativeId: z.number().int().positive(), walletEscrowId: z.string().max(40).nullish() });
export const eventCancelledBuyer: TemplateDefinition<z.infer<typeof cancelledBuyerPayload>> = {
  schema: cancelledBuyerPayload,
  needs: 'initiative',
  build(_payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'event.cancelledBuyer');
    const organization = organizationOf(context, 'event.cancelledBuyer');
    return {
      subject: t('event.cancelledBuyer.subject', { initiative: initiative.title }),
      preheader: t('event.cancelledBuyer.preheader'),
      title: t('event.cancelledBuyer.title'),
      paragraphs: [t('event.cancelledBuyer.body', { initiative: initiative.title, organization: organization.name }), t('event.cancelledBuyer.how')],
      facts: [],
      button: { label: t('event.cancelledBuyer.cta'), url: context.url(`/${organization.slug}`) },
      footer: 'transactional'
    };
  }
};

const rescheduledBuyerPayload = z.object({
  initiativeId: z.number().int().positive(),
  walletEscrowId: z.string().max(40).nullish(),
  rescheduleId: z.number().int().positive(),
  previousDate: z.string().datetime(),
  newDate: z.string().datetime(),
  refundUntil: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  refundToken: z.string().min(10).max(120)
});
export const eventRescheduledBuyer: TemplateDefinition<z.infer<typeof rescheduledBuyerPayload>> = {
  schema: rescheduledBuyerPayload,
  secretFields: ['refundToken'],
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'event.rescheduledBuyer');
    const organization = organizationOf(context, 'event.rescheduledBuyer');
    const newDate = dateOf(context, payload.newDate);
    const until = dateOf(context, payload.refundUntil);
    return {
      subject: t('event.rescheduledBuyer.subject', { initiative: initiative.title }),
      preheader: t('event.rescheduledBuyer.preheader', { date: newDate }),
      title: t('event.rescheduledBuyer.title'),
      paragraphs: [
        t('event.rescheduledBuyer.body', { initiative: initiative.title, organization: organization.name, date: newDate }),
        t('event.rescheduledBuyer.keep'),
        t('event.rescheduledBuyer.refund', { until }),
        t('event.rescheduledBuyer.private')
      ],
      facts: [
        { label: t('event.rescheduledBuyer.previousDate'), value: dateOf(context, payload.previousDate) },
        { label: t('event.rescheduledBuyer.newDate'), value: newDate },
        { label: t('event.rescheduledBuyer.until'), value: until }
      ],
      button: { label: t('event.rescheduledBuyer.cta'), url: `${context.url(eventRefundPath(organization.slug))}?${new URLSearchParams({ d: payload.refundToken }).toString()}` },
      footer: 'transactional'
    };
  }
};

/**
 * `gate.refundedPassUsed` (a quienes firman): un móvil de la portería sin cobertura dejó entrar un pase cuya devolución se pidió después con el enlace de un
 * cambio de fecha (auditoría de seguridad del Sprint 5.13). El dinero ya vuelve a quien compró; la entidad lo resuelve con esa persona fuera de la plataforma.
 * Solo el código del pase: ni nombre ni email.
 */
const refundedPassUsedPayload = z.object({ initiativeId: z.number().int().positive(), serialCode: z.string().max(40), scannedAt: z.string().datetime() });
export const gateRefundedPassUsed: TemplateDefinition<z.infer<typeof refundedPassUsedPayload>> = {
  schema: refundedPassUsedPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'gate.refundedPassUsed');
    const organization = organizationOf(context, 'gate.refundedPassUsed');
    return {
      subject: t('event.refundedPassUsed.subject', { initiative: initiative.title }),
      preheader: t('event.refundedPassUsed.preheader'),
      title: t('event.refundedPassUsed.title'),
      paragraphs: [t('event.refundedPassUsed.body', { initiative: initiative.title, pass: payload.serialCode, time: dateOf(context, payload.scannedAt) }), t('event.refundedPassUsed.next')],
      facts: [{ label: t('event.refundedPassUsed.pass'), value: payload.serialCode }],
      button: { label: t('event.changed.cta'), url: context.url(`/panel/${organization.slug}/taquilla`) },
      footer: 'organization'
    };
  }
};
