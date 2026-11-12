import { z } from 'zod';
import type { EmailContent, TemplateContext, TemplateDefinition } from './email-content';

/**
 * Avisos del relevo de firmantes (Sprint 4.2e), a las personas que firman por la entidad, **sin nombres ni emails** de nadie (un email puede
 * reenviarse): quién entra lo ve cada persona en el panel, con su sesión.
 *
 * - `REQUESTED`: a quien sale, cuando la otra firma propone su relevo. Es un aviso: no necesita su visto bueno (decisión del promotor, 2026-11-12).
 * - `COMPLETED`: la persona nueva ha aceptado; a quien sale (`leaving`, ya no firma) y a quien sigue en el otro puesto.
 * - `MODE_SINGLE`: la entidad pasa a firma única; a la persona que firmaba como cofirma (`leaving`, su puesto desaparece). Sin botón: ya no puede entrar.
 * - `EXPIRED`: a quien propuso un relevo que caducó sin que la persona invitada lo aceptara.
 * - `MODE_CHANGED`: a Dirección, cada vez que la entidad cambia de modo, para que se entere si el cambio no lo hizo ella.
 */

function organizationOf(context: TemplateContext): NonNullable<TemplateContext['organization']> {
  if (!context.organization) throw new Error('La plantilla signer.handover necesita una entidad.');
  return context.organization;
}

const payload = z.object({
  stage: z.enum(['REQUESTED', 'COMPLETED', 'MODE_SINGLE', 'MODE_CHANGED', 'EXPIRED']),
  role: z.enum(['DIRECTOR', 'COSIGNER']),
  /** Puede venir vacío si la persona no escribió su cargo: entonces se dice «Dirección» o «Cofirma» en el idioma del email. */
  roleLabel: z.string().max(60),
  leaving: z.boolean(),
  /** Solo en `MODE_CHANGED`: el modo al que ha pasado la entidad. */
  mode: z.enum(['DOUBLE', 'SINGLE']).optional()
});

export const signerHandover: TemplateDefinition<z.infer<typeof payload>> = {
  schema: payload,
  needs: 'organization',
  build(input, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context);
    const KEYS = { REQUESTED: 'requested', MODE_SINGLE: 'modeSingle', EXPIRED: 'expired', MODE_CHANGED: input.mode === 'SINGLE' ? 'modeChangedSingle' : 'modeChangedDouble' } as const;
    const key = input.stage === 'COMPLETED' ? (input.leaving ? 'completedLeaving' : 'completedStaying') : KEYS[input.stage];
    const values = { organization: organization.name, role: input.roleLabel.trim() || t(`signer.handover.seat.${input.role}`) };
    return {
      subject: t(`signer.handover.${key}.subject`, values),
      preheader: t(`signer.handover.${key}.preheader`),
      title: t(`signer.handover.${key}.title`),
      paragraphs: [t(`signer.handover.${key}.body`, values), t('signer.handover.why')],
      facts: [],
      // Quien deja el puesto de cofirma ya no puede entrar al panel: no se le ofrece un botón a una pantalla prohibida.
      ...(input.stage === 'MODE_SINGLE' ? {} : { button: { label: t('signer.handover.cta'), url: context.url(`/panel/${organization.slug}/ajustes#equipo`) } }),
      footer: 'organization'
    };
  }
};

/**
 * Resultado de la revisión del KYB (Sprint 5.2), a quienes firman por la entidad (EXPERIENCIA §4: «qué falta o confirmación»). La nota de una devolución
 * la escribe KORUM sin datos personales (el servidor la rechaza si lleva un email, un IBAN o un DNI); va en el texto del email, que se escapa al pintarlo.
 */
const kybPayload = z.object({
  stage: z.enum(['VERIFIED', 'REJECTED']),
  ley49: z.enum(['NOT_DECLARED', 'VERIFIED', 'NOT_ACCREDITED']).optional(),
  note: z.string().min(1).max(600).optional()
});

export const orgKybStatus: TemplateDefinition<z.infer<typeof kybPayload>> = {
  schema: kybPayload,
  needs: 'organization',
  build(input, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context);
    const values = { organization: organization.name };
    if (input.stage === 'VERIFIED') {
      const ley49 = input.ley49 ?? 'NOT_DECLARED';
      return {
        subject: t('org.kybStatus.verified.subject', values),
        preheader: t('org.kybStatus.verified.preheader'),
        title: t('org.kybStatus.verified.title'),
        paragraphs: [t('org.kybStatus.verified.body', values), ...(ley49 === 'NOT_DECLARED' ? [] : [t(`org.kybStatus.verified.ley49.${ley49}`)])],
        facts: [],
        button: { label: t('org.kybStatus.verified.cta'), url: context.url(`/panel/${organization.slug}`) },
        footer: 'organization'
      };
    }
    return {
      subject: t('org.kybStatus.rejected.subject', values),
      preheader: t('org.kybStatus.rejected.preheader'),
      title: t('org.kybStatus.rejected.title'),
      paragraphs: [t('org.kybStatus.rejected.body', values), ...(input.note ? [t('org.kybStatus.rejected.note', { note: input.note })] : []), t('org.kybStatus.rejected.next')],
      facts: [],
      button: { label: t('org.kybStatus.rejected.cta'), url: context.url(`/panel/${organization.slug}/ajustes#documentos`) },
      footer: 'organization'
    };
  }
};
