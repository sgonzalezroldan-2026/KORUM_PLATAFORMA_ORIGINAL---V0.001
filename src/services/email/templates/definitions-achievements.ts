import { z } from 'zod';
import type { EmailContent, TemplateContext, TemplateDefinition } from './email-content';

/**
 * Liquidación y logros (Sprint 4.4a, EXPERIENCIA §3 y §4).
 *
 * - `payout.executed`: a quienes firman, cuando el dinero de la hucha ya se ha enviado. El siguiente paso: las fotos del Después y el agradecimiento.
 * - `payout.changed`: a la otra persona firmante, cuando una liquidación que espera firmas cambia (destino, factura o cifras): sus firmas ya no valen.
 *   Sin el nombre del proveedor ni su IBAN (un email puede reenviarse): los ve en el panel.
 * - `initiative.goalReachedSupporter`: a quienes donaron, al llegar la campaña al 100 % («¡Lo hemos conseguido!», con *Compartir el logro*). Sin importes de
 *   nadie y sin nombres: el email puede reenviarse.
 * - `initiative.achievementPhotos`: a quienes donaron, cuando la campaña está cerrada y tiene el Antes y el Después («Mirad cómo ha quedado»).
 *
 * Los dos últimos los reparte por lotes la tarea `SUPPORTER_BROADCAST`; son avisos sobre el destino de su propia donación (pie `transactional`).
 */

function initiativeOf(context: TemplateContext, template: string): NonNullable<TemplateContext['initiative']> {
  if (!context.initiative) throw new Error(`La plantilla ${template} necesita una iniciativa.`);
  return context.initiative;
}

function organizationOf(context: TemplateContext, template: string): NonNullable<TemplateContext['organization']> {
  if (!context.organization) throw new Error(`La plantilla ${template} necesita una entidad.`);
  return context.organization;
}

const executedPayload = z.object({
  initiativeId: z.number().int().positive(),
  payoutId: z.number().int().positive(),
  amountCents: z.number().int().positive(),
  destinationType: z.enum(['ORGANIZATION', 'PROVIDER'])
});
export const payoutExecuted: TemplateDefinition<z.infer<typeof executedPayload>> = {
  schema: executedPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'payout.executed');
    const organization = organizationOf(context, 'payout.executed');
    const amount = context.formatMoney(payload.amountCents);
    return {
      subject: t('payout.executed.subject', { amount, initiative: initiative.title }),
      preheader: t('payout.executed.preheader'),
      title: t('payout.executed.title'),
      paragraphs: [t(`payout.executed.body${payload.destinationType}`, { amount, initiative: initiative.title }), t('payout.executed.next')],
      facts: [
        { label: t('payout.executed.reference'), value: `LQ-${payload.payoutId}` },
        { label: t('payout.executed.amount'), value: amount },
        { label: t('payout.executed.destination'), value: t(`payout.executed.destinations.${payload.destinationType}`) }
      ],
      button: { label: t('payout.executed.cta'), url: context.url(`/panel/${organization.slug}/logros`) },
      footer: 'organization'
    };
  }
};

const changedPayload = z.object({ initiativeId: z.number().int().positive(), payoutId: z.number().int().positive() });
export const payoutChanged: TemplateDefinition<z.infer<typeof changedPayload>> = {
  schema: changedPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'payout.changed');
    const organization = organizationOf(context, 'payout.changed');
    return {
      subject: t('payout.changed.subject', { reference: `LQ-${payload.payoutId}`, initiative: initiative.title }),
      preheader: t('payout.changed.preheader'),
      title: t('payout.changed.title'),
      paragraphs: [t('payout.changed.body', { initiative: initiative.title }), t('payout.changed.check')],
      facts: [{ label: t('payout.executed.reference'), value: `LQ-${payload.payoutId}` }],
      button: { label: t('payout.changed.cta'), url: context.url(`/panel/${organization.slug}/liquidaciones`) },
      footer: 'organization'
    };
  }
};

const supporterPayload = z.object({ initiativeId: z.number().int().positive(), walletEscrowId: z.string().max(40).nullish() });
export const initiativeGoalReachedSupporter: TemplateDefinition<z.infer<typeof supporterPayload>> = {
  schema: supporterPayload,
  needs: 'initiative',
  build(_payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'initiative.goalReachedSupporter');
    const organization = organizationOf(context, 'initiative.goalReachedSupporter');
    return {
      subject: t('supporter.goalReached.subject', { initiative: initiative.title }),
      preheader: t('supporter.goalReached.preheader', { organization: organization.name }),
      title: t('supporter.goalReached.title'),
      paragraphs: [
        t('supporter.goalReached.body', { initiative: initiative.title, organization: organization.name, count: initiative.totalContributions }),
        // El texto sale del estado al enviarse: en el plan gratuito la tarea de avisos corre una vez al día y la campaña puede estar ya liquidada (Sprint 5.5b).
        t(initiative.status === 'CLOSED' ? 'supporter.goalReached.nextSettled' : 'supporter.goalReached.next', { organization: organization.name })
      ],
      facts: [],
      button: { label: t('supporter.goalReached.cta'), url: context.url(`/${organization.slug}/logros`) },
      footer: 'transactional'
    };
  }
};

export const initiativeAchievementPhotos: TemplateDefinition<z.infer<typeof supporterPayload>> = {
  schema: supporterPayload,
  needs: 'initiative',
  build(_payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'initiative.achievementPhotos');
    const organization = organizationOf(context, 'initiative.achievementPhotos');
    return {
      subject: t('supporter.photos.subject', { initiative: initiative.title }),
      preheader: t('supporter.photos.preheader'),
      title: t('supporter.photos.title'),
      paragraphs: [t('supporter.photos.body', { initiative: initiative.title, organization: organization.name }), t('supporter.photos.thanks')],
      facts: [],
      button: { label: t('supporter.photos.cta'), url: context.url(`/${organization.slug}/logros`) },
      footer: 'transactional'
    };
  }
};
