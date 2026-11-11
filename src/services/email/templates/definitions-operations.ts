import { z } from 'zod';
import { safeDisplayText } from '@/core/security/safe-text';
import type { EmailContent, TemplateContext, TemplateDefinition } from './email-content';

/**
 * Emails de acceso, de operación de la entidad y de avisos periódicos: enlace y código de acceso, PIN de portería, meta lograda,
 * campaña vencida, ventana de reparto, certificado fiscal, Modelo 182 y aviso de inactividad.
 */

function organizationOf(context: TemplateContext, template: string): NonNullable<TemplateContext['organization']> {
  if (!context.organization) throw new Error(`La plantilla ${template} necesita una entidad.`);
  return context.organization;
}

function initiativeOf(context: TemplateContext, template: string): NonNullable<TemplateContext['initiative']> {
  if (!context.initiative) throw new Error(`La plantilla ${template} necesita una iniciativa.`);
  return context.initiative;
}

const minutesSchema = z.number().int().positive().max(1_440);

const magicLinkPayload = z.object({ url: z.url({ protocol: /^https?$/ }), minutes: minutesSchema });
export const authMagicLink: TemplateDefinition<z.infer<typeof magicLinkPayload>> = {
  schema: magicLinkPayload,
  secretFields: ['url'],
  build: (payload, { t }): EmailContent => ({
    subject: t('auth.magicLink.subject'),
    preheader: t('auth.magicLink.preheader'),
    title: t('auth.magicLink.title'),
    paragraphs: [t('auth.magicLink.body', { minutes: payload.minutes })],
    facts: [],
    button: { label: t('auth.magicLink.cta'), url: payload.url },
    footnote: t('auth.magicLink.footnote'),
    footer: 'account'
  })
};

const otpPayload = z.object({ code: z.string().regex(/^\d{6,8}$/), minutes: minutesSchema });
export const authOtp: TemplateDefinition<z.infer<typeof otpPayload>> = {
  schema: otpPayload,
  secretFields: ['code'],
  build: (payload, { t }): EmailContent => ({
    subject: t('auth.otp.subject'),
    preheader: t('auth.otp.preheader'),
    title: t('auth.otp.title'),
    paragraphs: [t('auth.otp.body', { minutes: payload.minutes })],
    facts: [],
    highlight: { label: t('auth.otp.codeLabel'), value: payload.code },
    footnote: t('auth.otp.footnote'),
    footer: 'account'
  })
};

const invitationPayload = z.object({
  url: z.url({ protocol: /^https?$/ }),
  hours: z.number().int().positive().max(168),
  organizationName: z.string().min(1).max(120).nullable(),
  roleLabel: z.string().min(1).max(60).nullable()
});
/** Invitación a activar una cuenta con contraseña: la segunda persona firmante de una entidad, o el primer Super-Admin (sin entidad). */
export const authInvitation: TemplateDefinition<z.infer<typeof invitationPayload>> = {
  schema: invitationPayload,
  secretFields: ['url'],
  build: (payload, { t }): EmailContent => {
    const organization = payload.organizationName;
    return {
      subject: organization !== null ? t('auth.invitation.subject', { organization }) : t('auth.invitation.subjectPlatform'),
      preheader: t('auth.invitation.preheader'),
      title: organization !== null ? t('auth.invitation.title', { organization }) : t('auth.invitation.titlePlatform'),
      paragraphs: [
        organization !== null ? t('auth.invitation.body', { organization, role: payload.roleLabel ?? '' }) : t('auth.invitation.bodyPlatform'),
        t('auth.invitation.security', { hours: payload.hours })
      ],
      facts: [],
      button: { label: t('auth.invitation.cta'), url: payload.url },
      footnote: t('auth.invitation.footnote'),
      footer: 'account'
    };
  }
};

const raffleNumbers = z.array(z.number().int().positive()).max(100).default([]);
const raffleExtraPayload = z.object({
  initiativeId: z.number().int().positive(),
  round: z.number().int().positive(),
  prizes: z.number().int().positive().max(100),
  reason: z.enum(['PRIZE_UNCLAIMED', 'WINNER_REFUNDED']),
  /** Las papeletas nuevas y los números ganadores que sustituyen: la otra persona firmante puede comprobar lo que se declaró. */
  numbers: raffleNumbers,
  replaced: raffleNumbers,
  /** Quién la hizo (su nombre en KORUM): quien recibe el aviso es de la misma entidad. */
  by: z.string().trim().max(120).optional(),
  /** Quién la hizo (identificador): permite quitar su nombre de este aviso si suprime su cuenta. */
  byUserId: z.string().max(64).optional()
});
const raffleLabel = (number: number) => `#${String(number).padStart(4, '0')}`;
/** Aviso a la otra persona firmante de que se ha hecho una ronda extra del sorteo (Sprint 4.6): la hace una sola, así que la otra queda informada y puede comprobar qué se sustituyó (Sprint 4.7). */
export const raffleExtraRound: TemplateDefinition<z.infer<typeof raffleExtraPayload>> = {
  schema: raffleExtraPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'raffle.extraRound');
    const organization = organizationOf(context, 'raffle.extraRound');
    return {
      subject: t('raffle.extraRound.subject', { initiative: initiative.title }),
      preheader: t('raffle.extraRound.preheader'),
      title: t('raffle.extraRound.title'),
      paragraphs: [t('raffle.extraRound.body', { by: safeDisplayText(payload.by ?? '') || t('raffle.extraRound.someone'), initiative: initiative.title, prizes: payload.prizes, round: payload.round, reason: t(`raffle.extraRound.reason.${payload.reason}`) })],
      facts: payload.numbers.length > 0 ? [{ label: t('raffle.extraRound.factNew'), value: payload.numbers.map(raffleLabel).join(', ') }, ...(payload.replaced.length > 0 ? [{ label: t('raffle.extraRound.factReplaced'), value: payload.replaced.map(raffleLabel).join(', ') }] : [])] : [],
      button: { label: t('raffle.extraRound.cta'), url: context.url(`/panel/${organization.slug}/taquilla`) },
      footer: 'organization'
    };
  }
};

const gatePayload = z.object({ initiativeId: z.number().int().positive() });
export const gatePinRevoked: TemplateDefinition<z.infer<typeof gatePayload>> = {
  schema: gatePayload,
  needs: 'initiative',
  build(_payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'gate.pinRevoked');
    const organization = organizationOf(context, 'gate.pinRevoked');
    return {
      subject: t('gate.pinRevoked.subject', { initiative: initiative.title }),
      preheader: t('gate.pinRevoked.preheader'),
      title: t('gate.pinRevoked.title'),
      paragraphs: [t('gate.pinRevoked.body', { initiative: initiative.title })],
      facts: [],
      button: { label: t('gate.pinRevoked.cta'), url: context.url(`/panel/${organization.slug}/taquilla`) },
      footer: 'organization'
    };
  }
};

export const initiativeGoalReached: TemplateDefinition<z.infer<typeof gatePayload>> = {
  schema: gatePayload,
  needs: 'initiative',
  build(_payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'initiative.goalReached');
    const organization = organizationOf(context, 'initiative.goalReached');
    return {
      subject: t('goalReached.subject', { initiative: initiative.title }),
      preheader: t('goalReached.preheader'),
      title: t('goalReached.title'),
      paragraphs: [t('goalReached.body', { initiative: initiative.title, goal: context.formatMoney(initiative.goalCents), count: initiative.totalContributions }), t('goalReached.next')],
      facts: [],
      button: { label: t('goalReached.cta'), url: context.url(`/panel/${organization.slug}`) },
      footer: 'organization'
    };
  }
};

const expiredPayload = z.object({ initiativeId: z.number().int().positive(), walletEscrowId: z.string().nullish(), raisedCents: z.number().int().nonnegative(), goalCents: z.number().int().positive() });
export const initiativeExpired: TemplateDefinition<z.infer<typeof expiredPayload>> = {
  schema: expiredPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'initiative.expired');
    const organization = organizationOf(context, 'initiative.expired');
    return {
      subject: t('expired.subject', { initiative: initiative.title }),
      preheader: t('expired.preheader'),
      title: t('expired.title'),
      paragraphs: [t('expired.body', { initiative: initiative.title, raised: context.formatMoney(payload.raisedCents), goal: context.formatMoney(payload.goalCents) })],
      facts: [],
      button: { label: t('expired.cta'), url: context.url(`/panel/${organization.slug}/vencidas`) },
      footer: 'organization'
    };
  }
};

const splitPayload = z.object({ initiativeId: z.number().int().positive(), walletEscrowId: z.string().nullish(), daysLeft: z.number().int() });
export const splitWindowExpiring: TemplateDefinition<z.infer<typeof splitPayload>> = {
  schema: splitPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'split.windowExpiring');
    const organization = organizationOf(context, 'split.windowExpiring');
    const days = Math.max(payload.daysLeft, 0);
    return {
      subject: t('split.expiring.subject', { days, initiative: initiative.title }),
      preheader: t('split.expiring.preheader'),
      title: t('split.expiring.title'),
      paragraphs: [t('split.expiring.body', { days, initiative: initiative.title })],
      facts: [],
      button: { label: t('split.expiring.cta'), url: context.url(`/panel/${organization.slug}`) },
      footer: 'organization'
    };
  }
};

export const splitWindowExpired: TemplateDefinition<z.infer<typeof splitPayload>> = {
  schema: splitPayload,
  needs: 'initiative',
  build(_payload, context): EmailContent {
    const { t } = context;
    const initiative = initiativeOf(context, 'split.windowExpired');
    const organization = organizationOf(context, 'split.windowExpired');
    return {
      subject: t('split.expired.subject', { initiative: initiative.title }),
      preheader: t('split.expired.preheader'),
      title: t('split.expired.title'),
      paragraphs: [t('split.expired.body', { initiative: initiative.title })],
      facts: [],
      button: { label: t('split.expired.cta'), url: context.url(`/panel/${organization.slug}`) },
      footer: 'organization'
    };
  }
};

const yearPayload = z.object({ fiscalYear: z.number().int().min(2020).max(2100) });
export const taxCertificateReady: TemplateDefinition<z.infer<typeof yearPayload>> = {
  schema: yearPayload,
  build: (payload, context): EmailContent => ({
    subject: context.t('tax.certificateReady.subject', { year: payload.fiscalYear }),
    preheader: context.t('tax.certificateReady.preheader'),
    title: context.t('tax.certificateReady.title'),
    paragraphs: [context.t('tax.certificateReady.body', { year: payload.fiscalYear })],
    facts: [],
    button: { label: context.t('tax.certificateReady.cta'), url: context.url('/mi-cuenta/certificados') },
    footer: 'account'
  })
};

export const model182Reminder: TemplateDefinition<z.infer<typeof yearPayload>> = {
  schema: yearPayload,
  needs: 'organization',
  build(payload, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context, 'model182.reminder');
    return {
      subject: t('model182.subject', { year: payload.fiscalYear }),
      preheader: t('model182.preheader'),
      title: t('model182.title'),
      paragraphs: [t('model182.body', { year: payload.fiscalYear })],
      facts: [],
      button: { label: t('model182.cta'), url: context.url(`/panel/${organization.slug}/fiscal`) },
      footer: 'organization'
    };
  }
};

const inactivityPayload = z.object({ eraseOn: z.iso.datetime() });
export const privacyInactivityNotice: TemplateDefinition<z.infer<typeof inactivityPayload>> = {
  schema: inactivityPayload,
  build(payload, context): EmailContent {
    const { t } = context;
    const date = context.formatDate(payload.eraseOn);
    return {
      subject: t('inactivity.subject', { date }),
      preheader: t('inactivity.preheader'),
      title: t('inactivity.title'),
      paragraphs: [t('inactivity.body', { date }), t('inactivity.kept'), t('inactivity.keep')],
      facts: [],
      button: { label: t('inactivity.cta'), url: context.url('/login') },
      footer: 'account'
    };
  }
};
