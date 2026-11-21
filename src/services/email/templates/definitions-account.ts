import { z } from 'zod';
import type { EmailContent, TemplateDefinition } from './email-content';

/**
 * Avisos de seguridad de la cuenta (Sprint 3.7). `account.passkeyAdded`: al añadir una llave de acceso, la persona lo sabe aunque no haya sido
 * ella (auditoría del 3.7, I3): una llave abre sesiones sin email ni contraseña y sobrevive a un cambio de contraseña. Sin datos de la llave.
 */

const emptyPayload = z.object({}).strict();

export const accountPasskeyAdded: TemplateDefinition<z.infer<typeof emptyPayload>> = {
  schema: emptyPayload,
  build: (_payload, { t, url }): EmailContent => ({
    subject: t('account.passkeyAdded.subject'),
    preheader: t('account.passkeyAdded.preheader'),
    title: t('account.passkeyAdded.title'),
    paragraphs: [t('account.passkeyAdded.body')],
    facts: [],
    button: { label: t('account.passkeyAdded.cta'), url: url('/mi-cuenta/privacidad#security') },
    footnote: t('account.passkeyAdded.footnote'),
    footer: 'account'
  })
};

/**
 * Acuse de una consulta de soporte (Sprint 3.9): el código para citarla y, si pide corregir datos personales, el plazo de un mes (RGPD art. 12.3).
 * No repite el texto de la consulta: un email puede reenviarse o leerse en una pantalla ajena.
 */
const supportReceivedPayload = z.object({ ticketCode: z.string().regex(/^TCK-[A-HJKMNP-Z2-9]{6}$/), rectification: z.boolean(), answeredBy: z.enum(['ORGANIZATION', 'SUPERADMIN']) });

export const supportReceived: TemplateDefinition<z.infer<typeof supportReceivedPayload>> = {
  schema: supportReceivedPayload,
  build: (payload, { t, url }): EmailContent => ({
    subject: t('support.received.subject', { code: payload.ticketCode }),
    preheader: t('support.received.preheader'),
    title: t('support.received.title'),
    paragraphs: [t(payload.answeredBy === 'ORGANIZATION' ? 'support.received.bodyOrganization' : 'support.received.bodyPlatform'), ...(payload.rectification ? [t('support.received.rectification')] : [])],
    facts: [{ label: t('support.received.code'), value: payload.ticketCode }],
    button: { label: t('support.received.cta'), url: url('/mi-cuenta#support') },
    footer: 'account'
  })
};

/**
 * Aviso de que el centro ha contestado una consulta (Sprint 4.4c). Como el aviso de una idea contestada, **no copia la respuesta**: un email puede
 * reenviarse o leerse en una pantalla ajena, y la respuesta puede aludir a la situación de una familia; se lee en *Mi cuenta*.
 */
const supportRepliedPayload = z.object({
  ticketCode: z.string().regex(/^TCK-[A-HJKMNP-Z2-9]{6}$/),
  organization: z.string().min(1).max(200),
  /** Solo cuando KORUM contesta lo que escribió una entidad (Sprint 5.3): la respuesta se lee en el panel de la entidad, no en *Mi cuenta*. */
  panelOrgSlug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .optional()
});

export const supportReplied: TemplateDefinition<z.infer<typeof supportRepliedPayload>> = {
  schema: supportRepliedPayload,
  build: (payload, { t, url }): EmailContent => ({
    subject: t('support.replied.subject', { organization: payload.organization, code: payload.ticketCode }),
    preheader: t('support.replied.preheader'),
    title: t('support.replied.title'),
    paragraphs: [t(payload.panelOrgSlug ? 'support.replied.bodyPanel' : 'support.replied.body', { organization: payload.organization })],
    facts: [{ label: t('support.received.code'), value: payload.ticketCode }],
    button: payload.panelOrgSlug ? { label: t('support.replied.ctaPanel'), url: url('/panel/' + payload.panelOrgSlug + '/soporte') } : { label: t('support.replied.cta'), url: url('/mi-cuenta#support') },
    footer: 'account'
  })
};

/**
 * Cambio de email de la cuenta (Sprint 5.10b, `L-053`). `account.emailChangeCode`: el código de 6 dígitos al email **nuevo**, que demuestra que la persona lo controla;
 * es un secreto (se borra de la bandeja al enviarse y no sale pasada una hora). `account.emailChanged`: aviso al email **antiguo** de que ya no es el de la cuenta, para
 * que lo sepa aunque no haya sido ella. Ninguno de los dos lleva la otra dirección: un email puede reenviarse o leerse en una pantalla ajena.
 */
const emailChangeCodePayload = z.object({ code: z.string().regex(/^\d{6}$/), minutes: z.number().int().positive().max(60) });

export const accountEmailChangeCode: TemplateDefinition<z.infer<typeof emailChangeCodePayload>> = {
  schema: emailChangeCodePayload,
  secretFields: ['code'],
  build: (payload, { t }): EmailContent => ({
    subject: t('account.emailChangeCode.subject'),
    preheader: t('account.emailChangeCode.preheader'),
    title: t('account.emailChangeCode.title'),
    paragraphs: [t('account.emailChangeCode.body', { minutes: payload.minutes })],
    facts: [],
    highlight: { label: t('account.emailChangeCode.codeLabel'), value: payload.code },
    footnote: t('account.emailChangeCode.footnote'),
    footer: 'account'
  })
};

/** `revertUrl`: el enlace «No he sido yo» (un solo uso, 14 días). Es un secreto: se borra de la bandeja al enviarse y no sale pasado `expiresAt`. */
const emailChangedPayload = z.object({ changedAt: z.string().datetime(), revertUrl: z.url({ protocol: /^https?$/ }), expiresAt: z.string().datetime(), days: z.number().int().positive().max(30) });

export const accountEmailChanged: TemplateDefinition<z.infer<typeof emailChangedPayload>> = {
  schema: emailChangedPayload,
  secretFields: ['revertUrl'],
  build: (payload, { t, formatDateTime }): EmailContent => ({
    subject: t('account.emailChanged.subject'),
    preheader: t('account.emailChanged.preheader'),
    title: t('account.emailChanged.title'),
    paragraphs: [t('account.emailChanged.body', { date: formatDateTime(payload.changedAt) }), t('account.emailChanged.notYou', { days: payload.days })],
    facts: [],
    button: { label: t('account.emailChanged.cta'), url: payload.revertUrl },
    footnote: t('account.emailChanged.footnote'),
    footer: 'account'
  })
};
