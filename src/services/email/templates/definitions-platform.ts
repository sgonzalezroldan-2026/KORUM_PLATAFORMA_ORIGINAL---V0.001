import { z } from 'zod';
import type { EmailContent, TemplateDefinition } from './email-content';

/**
 * Email directo de KORUM a quienes firman por una entidad (Sprint 5.3, prototipo `✉️ Enviar email directo al centro`). A diferencia del resto del catálogo, el
 * texto lo escribe una persona (el Super-Admin) y viaja en el payload: por eso el esquema lo acota (asunto y mensaje con la misma longitud que una consulta de
 * soporte, sin enlaces ni botones propios) y el pie dice de quién viene. Un botón único lleva al panel de la entidad. Nunca incluye datos de las familias.
 */

const payload = z.object({
  organization: z.string().min(1).max(200),
  subject: z.string().min(5).max(120),
  message: z.string().min(20).max(2000),
  /** Hasta cuándo se puede enviar: el texto se borra al enviarse (campo secreto), y sin una fecha propia la bandeja lo cancelaría a la hora de escribirlo. */
  expiresAt: z.string().datetime().optional()
});

export const platformMessage: TemplateDefinition<z.infer<typeof payload>> = {
  schema: payload,
  needs: 'organization',
  // Lo escribe el equipo de KORUM: el remitente es KORUM, no «{Entidad} vía KORUM» (un texto libre no debe parecer del propio centro).
  sender: 'platform',
  // El texto libre no se conserva en la bandeja de salida una vez enviado (privacidad): se borra como los códigos de un solo uso.
  secretFields: ['subject', 'message'],
  build: (input, { t, url, organization }): EmailContent => ({
    subject: t('platform.message.subject', { subject: input.subject }),
    preheader: t('platform.message.preheader', { organization: input.organization }),
    title: input.subject,
    // Los párrafos de la persona que escribe se conservan: una línea en blanco separa uno de otro.
    paragraphs: input.message.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter((paragraph) => paragraph !== ''),
    facts: [],
    ...(organization ? { button: { label: t('platform.message.cta'), url: url(`/panel/${organization.slug}/soporte`) } } : {}),
    footnote: t('platform.message.footnote'),
    footer: 'organization'
  })
};
