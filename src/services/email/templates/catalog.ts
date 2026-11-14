import type { EmailContent, TemplateContext, TemplateDefinition } from './email-content';
import {
  authInvitation,
  authMagicLink,
  authOtp,
  gatePinRevoked,
  raffleExtraRound,
  initiativeExpired,
  initiativeGoalReached,
  model182Reminder,
  privacyInactivityNotice,
  splitWindowExpired,
  splitWindowExpiring,
  taxCertificateReady
} from './definitions-operations';
import { contributionReceipt, doubleCheckPending, refundIssued, ticketPass } from './definitions-transactions';
import { accountPasskeyAdded, supportReceived, supportReplied } from './definitions-account';
import { ideaCenterReplied, ideaQuorumReached } from './definitions-ideas';
import { pledgeCharged, pledgeFailed, pledgeSkipped } from './definitions-pledge';
import { activityFundPaid, activityFundReceived, activityFundReminder, sponsorAwaitingDecision, sponsorLateReceived, sponsorToEntityFund } from './definitions-activity-fund';
import { sponsorCreditPool, sponsorReassigned, sponsorRejected, sponsorRenewalInvite, sponsorRenewalLink, sponsorRenewalNotice, sponsorRenewed, sponsorWelcome } from './definitions-sponsors';
import { orgKybStatus, signerHandover } from './definitions-team';
import { platformMessage } from './definitions-platform';
import { initiativeAchievementPhotos, initiativeGoalReachedSupporter, payoutChanged, payoutExecuted } from './definitions-achievements';
import { expiredDecisionReminder, initiativeExpiredDecided, initiativeRefundingSupporter, initiativeResizeClosed, initiativeResizePoll, initiativeResizeResult } from './definitions-resize';

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
  sender: NonNullable<TemplateDefinition<unknown>['sender']>;
  build: (rawPayload: unknown, context: TemplateContext) => Promise<EmailContent>;
}

function register<Payload>(templateKey: string, definition: TemplateDefinition<Payload>): [string, RegisteredTemplate] {
  return [
    templateKey,
    {
      secretFields: definition.secretFields ?? [],
      needs: definition.needs,
      sender: definition.sender ?? 'organization',
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
  register('raffle.extraRound', raffleExtraRound),
  register('initiative.goalReached', initiativeGoalReached),
  register('initiative.expired', initiativeExpired),
  register('refund.issued', refundIssued),
  register('doubleCheck.pending', doubleCheckPending),
  register('split.windowExpiring', splitWindowExpiring),
  register('split.windowExpired', splitWindowExpired),
  register('sponsor.renewalNotice', sponsorRenewalNotice),
  register('sponsor.welcome', sponsorWelcome),
  register('sponsor.rejected', sponsorRejected),
  register('sponsor.renewalLink', sponsorRenewalLink),
  register('sponsor.renewed', sponsorRenewed),
  register('sponsor.reassigned', sponsorReassigned),
  register('sponsor.creditPool', sponsorCreditPool),
  register('sponsor.renewalInvite', sponsorRenewalInvite),
  register('sponsor.toEntityFund', sponsorToEntityFund),
  register('sponsor.awaitingDecision', sponsorAwaitingDecision),
  register('sponsor.lateReceived', sponsorLateReceived),
  register('activityFund.received', activityFundReceived),
  register('activityFund.reminder', activityFundReminder),
  register('activityFund.paid', activityFundPaid),
  register('tax.certificateReady', taxCertificateReady),
  register('model182.reminder', model182Reminder),
  register('privacy.inactivityNotice', privacyInactivityNotice),
  register('account.passkeyAdded', accountPasskeyAdded),
  register('support.received', supportReceived),
  register('support.replied', supportReplied),
  register('platform.message', platformMessage),
  register('pledge.charged', pledgeCharged),
  register('pledge.skipped', pledgeSkipped),
  register('pledge.failed', pledgeFailed),
  register('idea.quorumReached', ideaQuorumReached),
  register('idea.centerReplied', ideaCenterReplied),
  register('signer.handover', signerHandover),
  register('org.kybStatus', orgKybStatus),
  register('payout.executed', payoutExecuted),
  register('payout.changed', payoutChanged),
  register('initiative.goalReachedSupporter', initiativeGoalReachedSupporter),
  register('initiative.achievementPhotos', initiativeAchievementPhotos),
  register('initiative.expiredDecided', initiativeExpiredDecided),
  register('initiative.resizeClosed', initiativeResizeClosed),
  register('initiative.resizePoll', initiativeResizePoll),
  register('initiative.resizeResult', initiativeResizeResult),
  register('initiative.refundingSupporter', initiativeRefundingSupporter),
  register('expired.decisionReminder', expiredDecisionReminder)
];

export const TEMPLATE_CATALOG: ReadonlyMap<string, RegisteredTemplate> = new Map(ENTRIES);

/** Campos secretos de un mensaje (vacío si la plantilla no existe): se borran de la bandeja al enviarlo o cancelarlo. */
export function secretFieldsOf(templateKey: string): readonly string[] {
  return TEMPLATE_CATALOG.get(templateKey)?.secretFields ?? [];
}
