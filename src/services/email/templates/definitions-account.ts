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
    button: { label: t('account.passkeyAdded.cta'), url: url('/mi-cuenta#security') },
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
const supportRepliedPayload = z.object({ ticketCode: z.string().regex(/^TCK-[A-HJKMNP-Z2-9]{6}$/), organization: z.string().min(1).max(200) });

export const supportReplied: TemplateDefinition<z.infer<typeof supportRepliedPayload>> = {
  schema: supportRepliedPayload,
  build: (payload, { t, url }): EmailContent => ({
    subject: t('support.replied.subject', { organization: payload.organization, code: payload.ticketCode }),
    preheader: t('support.replied.preheader'),
    title: t('support.replied.title'),
    paragraphs: [t('support.replied.body', { organization: payload.organization })],
    facts: [{ label: t('support.received.code'), value: payload.ticketCode }],
    button: { label: t('support.replied.cta'), url: url('/mi-cuenta#support') },
    footer: 'account'
  })
};
