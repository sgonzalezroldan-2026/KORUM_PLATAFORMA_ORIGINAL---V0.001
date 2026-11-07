import type { EmailContent, TemplateContext, TemplateDefinition } from './email-content';
import {
  authInvitation,
  authMagicLink,
  authOtp,
  gatePinRevoked,
  initiativeExpired,
  initiativeGoalReached,
  model182Reminder,
  privacyInactivityNotice,
  splitWindowExpired,
  splitWindowExpiring,
  sponsorRenewalNotice,
  taxCertificateReady
} from './definitions-operations';
import { contributionReceipt, doubleCheckPending, refundIssued, ticketPass } from './definitions-transactions';
import { accountPasskeyAdded } from './definitions-account';

/**
 * Catálogo de plantillas (`templateKey` → definición). Las claves son las de EXPERIENCIA_DE_PRODUCTO §4. Una clave que no está aquí no
 * se puede enviar: la bandeja marca el mensaje como fallido y abre una alerta en lugar de reintentarlo para siempre.
 */

export class InvalidPayloadError extends Error {
  constructor(templateKey: string, issues: string[]) {
    super(`El mensaje ${templateKey} no tiene la forma esperada: ${issues.join('; ')}`);
    this.name = 'InvalidPayloadError';
  }
}

export interface RegisteredTemplate {
  secretFields: readonly string[];
  needs: TemplateDefinition<unknown>['needs'];
  build: (rawPayload: unknown, context: TemplateContext) => Promise<EmailContent>;
}

function register<Payload>(templateKey: string, definition: TemplateDefinition<Payload>): [string, RegisteredTemplate] {
  return [
    templateKey,
    {
      secretFields: definition.secretFields ?? [],
      needs: definition.needs,
      build: async (rawPayload, context) => {
        const parsed = definition.schema.safeParse(rawPayload);
        // Solo la ruta del campo, nunca su valor: el payload puede llevar enlaces o códigos de un solo uso.
        if (!parsed.success) throw new InvalidPayloadError(templateKey, parsed.error.issues.map((issue) => issue.path.join('.') || '(raíz)'));
        return definition.build(parsed.data, context);
      }
    }
  ];
}

const ENTRIES = [
  register('auth.magicLink', authMagicLink),
  register('auth.otp', authOtp),
  register('auth.invitation', authInvitation),
  register('contribution.receipt', contributionReceipt),
  register('ticket.pass', ticketPass),
  register('gate.pinRevoked', gatePinRevoked),
  register('initiative.goalReached', initiativeGoalReached),
  register('initiative.expired', initiativeExpired),
  register('refund.issued', refundIssued),
  register('doubleCheck.pending', doubleCheckPending),
  register('split.windowExpiring', splitWindowExpiring),
  register('split.windowExpired', splitWindowExpired),
  register('sponsor.renewalNotice', sponsorRenewalNotice),
  register('tax.certificateReady', taxCertificateReady),
  register('model182.reminder', model182Reminder),
  register('privacy.inactivityNotice', privacyInactivityNotice),
  register('account.passkeyAdded', accountPasskeyAdded)
];

export const TEMPLATE_CATALOG: ReadonlyMap<string, RegisteredTemplate> = new Map(ENTRIES);

/** Campos secretos de un mensaje (vacío si la plantilla no existe): se borran de la bandeja al enviarlo o cancelarlo. */
export function secretFieldsOf(templateKey: string): readonly string[] {
  return TEMPLATE_CATALOG.get(templateKey)?.secretFields ?? [];
}
