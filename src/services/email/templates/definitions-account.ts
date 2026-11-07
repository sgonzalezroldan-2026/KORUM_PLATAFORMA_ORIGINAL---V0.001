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
