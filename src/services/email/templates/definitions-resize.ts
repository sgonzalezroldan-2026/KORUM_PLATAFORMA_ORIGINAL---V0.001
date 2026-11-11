import { z } from 'zod';
import { resizeVotePath } from '@/lib/seo/portal-routes';
import type { EmailContent, TemplateContext, TemplateDefinition } from './email-content';

/**
 * Campañas vencidas sin llegar a la meta (Sprint 4.4b, EXPERIENCIA §3 y §4).
 *
 * A quienes firman:
 * - `initiative.expiredDecided`: una persona firmante ha decidido (reembolsar o lanzar la votación). La otra se entera al momento.
 * - `initiative.resizeClosed`: la votación se ha cerrado; o ganó un proyecto (toca liquidar con la meta nueva) o se devuelve a todas las personas.
 *
 * A quienes donaron (por lotes, una vez por persona; avisos sobre el destino de su propia donación, pie `transactional`):
 * - `initiative.resizePoll`: la votación, con su enlace personal (`voteToken`, campo secreto: se borra de la bandeja al enviarlo).
 * - `initiative.resizeResult`: ganó un proyecto y se hace con lo recaudado.
 * - `initiative.refundingSupporter`: se devuelve el 100 % al medio de pago original.
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

const decidedPayload = z.object({ initiativeId: z.number().int().positive(), decision: z.enum(['REFUND', 'RESIZE_VOTE']), closesAt: z.string().datetime().optional() });
export const initiativeExpiredDecided: TemplateDefinition<z.infer<typeof decidedPayload>> = {
  schema: decidedPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'initiative.expiredDecided');
    const organization = organizationOf(context, 'initiative.expiredDecided');
    const vote = payload.decision === 'RESIZE_VOTE';
    return {
      subject: t(vote ? 'resize.decided.voteSubject' : 'resize.decided.refundSubject', { initiative: initiative.title }),
      preheader: t(vote ? 'resize.decided.votePreheader' : 'resize.decided.refundPreheader'),
      title: t(vote ? 'resize.decided.voteTitle' : 'resize.decided.refundTitle'),
      paragraphs: [vote ? t('resize.decided.voteBody', { initiative: initiative.title, date: payload.closesAt ? dateOf(context, payload.closesAt) : '' }) : t('resize.decided.refundBody', { initiative: initiative.title })],
      facts: [],
      button: { label: t('resize.decided.cta'), url: context.url(`/panel/${organization.slug}/vencidas`) },
      footer: 'organization'
    };
  }
};

const closedPayload = z.object({ initiativeId: z.number().int().positive(), outcome: z.enum(['PROJECT', 'NO_VOTES', 'TIE', 'NOTHING_LEFT']), newGoalCents: z.number().int().positive().optional(), option: z.string().max(200).optional() });
export const initiativeResizeClosed: TemplateDefinition<z.infer<typeof closedPayload>> = {
  schema: closedPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'initiative.resizeClosed');
    const organization = organizationOf(context, 'initiative.resizeClosed');
    const won = payload.outcome === 'PROJECT' && payload.newGoalCents !== undefined;
    return {
      subject: t(won ? 'resize.closed.wonSubject' : 'resize.closed.refundSubject', { initiative: initiative.title }),
      preheader: t(won ? 'resize.closed.wonPreheader' : 'resize.closed.refundPreheader'),
      title: t(won ? 'resize.closed.wonTitle' : 'resize.closed.refundTitle'),
      paragraphs: won
        ? [t('resize.closed.wonBody', { initiative: initiative.title, option: payload.option ?? '', amount: context.formatMoney(payload.newGoalCents ?? 0) }), t('resize.closed.wonNext')]
        : [t(`resize.closed.reason${payload.outcome}`, { initiative: initiative.title }), t('resize.closed.refundNext')],
      facts: won ? [{ label: t('resize.closed.newGoal'), value: context.formatMoney(payload.newGoalCents ?? 0) }] : [],
      button: won ? { label: t('resize.closed.settleCta'), url: context.url(`/panel/${organization.slug}/liquidaciones`) } : { label: t('resize.decided.cta'), url: context.url(`/panel/${organization.slug}/vencidas`) },
      footer: 'organization'
    };
  }
};

const pollPayload = z.object({ initiativeId: z.number().int().positive(), walletEscrowId: z.string().max(40).nullish(), pollId: z.number().int().positive(), closesAt: z.string().datetime(), expiresAt: z.string().datetime().optional(), voteToken: z.string().min(10).max(120) });
export const initiativeResizePoll: TemplateDefinition<z.infer<typeof pollPayload>> = {
  schema: pollPayload,
  secretFields: ['voteToken'],
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'initiative.resizePoll');
    const organization = organizationOf(context, 'initiative.resizePoll');
    const date = dateOf(context, payload.closesAt);
    return {
      subject: t('resize.poll.subject', { initiative: initiative.title }),
      preheader: t('resize.poll.preheader', { date }),
      title: t('resize.poll.title'),
      paragraphs: [t('resize.poll.body', { initiative: initiative.title, organization: organization.name }), t('resize.poll.rules', { date }), t('resize.poll.refund')],
      facts: [{ label: t('resize.poll.until'), value: date }],
      button: { label: t('resize.poll.cta'), url: `${context.url(resizeVotePath(organization.slug))}?${new URLSearchParams({ v: payload.voteToken }).toString()}` },
      footer: 'transactional'
    };
  }
};

const resultPayload = z.object({ initiativeId: z.number().int().positive(), walletEscrowId: z.string().max(40).nullish(), option: z.string().max(200), newGoalCents: z.number().int().positive() });
export const initiativeResizeResult: TemplateDefinition<z.infer<typeof resultPayload>> = {
  schema: resultPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'initiative.resizeResult');
    const organization = organizationOf(context, 'initiative.resizeResult');
    return {
      subject: t('resize.result.subject', { initiative: initiative.title }),
      preheader: t('resize.result.preheader', { organization: organization.name }),
      title: t('resize.result.title'),
      paragraphs: [t('resize.result.body', { initiative: initiative.title, option: payload.option }), t('resize.result.next', { organization: organization.name })],
      facts: [],
      button: { label: t('resize.result.cta'), url: context.url(`/${organization.slug}/logros`) },
      footer: 'transactional'
    };
  }
};

const supporterPayload = z.object({ initiativeId: z.number().int().positive(), walletEscrowId: z.string().max(40).nullish() });
export const initiativeRefundingSupporter: TemplateDefinition<z.infer<typeof supporterPayload>> = {
  schema: supporterPayload,
  needs: 'initiative',
  build(_payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'initiative.refundingSupporter');
    const organization = organizationOf(context, 'initiative.refundingSupporter');
    return {
      subject: t('resize.refunding.subject', { initiative: initiative.title }),
      preheader: t('resize.refunding.preheader'),
      title: t('resize.refunding.title'),
      paragraphs: [t('resize.refunding.body', { initiative: initiative.title, organization: organization.name }), t('resize.refunding.how'), t('resize.refunding.thanks', { organization: organization.name })],
      facts: [],
      button: { label: t('resize.refunding.cta'), url: context.url(`/${organization.slug}`) },
      footer: 'transactional'
    };
  }
};
