import { z } from 'zod';
import type { EmailContent, TemplateContext, TemplateDefinition } from './email-content';

/**
 * Avisos del relevo de firmantes (Sprint 4.2e), a las personas que firman por la entidad, **sin nombres ni emails** de nadie (un email puede
 * reenviarse): quién entra lo ve cada persona en el panel, con su sesión.
 *
 * - `REQUESTED`: a quien sale, cuando la otra firma propone su relevo; tiene que dar su visto bueno con su código (o rechazarlo) en el panel.
 * - `DECLINED`: a quien lo propuso, cuando quien sale lo rechaza.
 * - `COMPLETED`: la persona nueva ha aceptado; a quien sale (`leaving`, ya no firma) y a quien sigue en el otro puesto.
 */

function organizationOf(context: TemplateContext): NonNullable<TemplateContext['organization']> {
  if (!context.organization) throw new Error('La plantilla signer.handover necesita una entidad.');
  return context.organization;
}

const payload = z.object({
  stage: z.enum(['REQUESTED', 'DECLINED', 'COMPLETED']),
  role: z.enum(['DIRECTOR', 'COSIGNER']),
  roleLabel: z.string().min(1).max(60),
  leaving: z.boolean()
});

export const signerHandover: TemplateDefinition<z.infer<typeof payload>> = {
  schema: payload,
  needs: 'organization',
  build(input, context): EmailContent {
    const { t } = context;
    const organization = organizationOf(context);
    const key = input.stage === 'COMPLETED' ? (input.leaving ? 'completedLeaving' : 'completedStaying') : input.stage === 'REQUESTED' ? 'requested' : 'declined';
    const values = { organization: organization.name, role: input.roleLabel };
    return {
      subject: t(`signer.handover.${key}.subject`, values),
      preheader: t(`signer.handover.${key}.preheader`),
      title: t(`signer.handover.${key}.title`),
      paragraphs: [t(`signer.handover.${key}.body`, values), t('signer.handover.why')],
      facts: [],
      button: {
        label: t('signer.handover.cta'),
        url: context.url(`/panel/${organization.slug}/ajustes#equipo`)
      },
      footer: 'organization'
    };
  }
};
