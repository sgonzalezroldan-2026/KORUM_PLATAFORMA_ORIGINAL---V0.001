import { auditTargetKeyOf, ENTITY_PROBE_ACTION, isKnownAuditAction } from '@/core/audit/audit-catalog';
import type { DossierTexts } from './dossier-sheet';

/**
 * Los textos del expediente exportable (Sprint 5.8b), a partir de un traductor de cada rama del catálogo. Así la descarga (con las traducciones de
 * servidor) y las pruebas (con el catálogo leído del disco) componen exactamente el mismo PDF. Sin base de datos ni dependencias de Next.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface DossierTranslators {
  /** `audit.dossier` */
  dossier: Translate;
  /** `audit` (actores, objetivos, motivos y los textos comunes del visor). */
  audit: Translate;
  /** `audit.actions` */
  actions: Translate;
  /** `status.initiative` */
  statuses: Translate;
  /** `panel.approvals.doubleCheck.roles` */
  roles: Translate;
}

/**
 * Plantillas de email con nombre en lenguaje llano (`audit.dossier.emailTemplates.*`): las del catálogo de `src/services/email/templates/catalog.ts`
 * (`tests/unit/dossier-pdf.spec.ts` vigila que no falte ninguna). Una que aún no esté aquí sale como «otro aviso», nunca con su código interno.
 */
export const DOSSIER_EMAIL_TEMPLATE_KEYS: ReadonlySet<string> = new Set([
  'auth.magicLink', 'auth.otp', 'auth.invitation', 'contribution.receipt', 'ticket.pass', 'voucher.pass', 'voucher.noProductReceipt', 'voucher.saleClosed', 'voucher.changed', 'voucher.cancelledBuyer', 'voucher.validityChanged', 'voucher.expiryReminder', 'gate.pinRevoked', 'initiative.goalReached', 'initiative.expired', 'refund.issued',
  'doubleCheck.pending', 'split.windowExpiring', 'split.windowExpired', 'sponsor.renewalNotice', 'sponsor.welcome', 'sponsor.rejected', 'sponsor.renewalLink', 'sponsor.renewed', 'sponsor.reassigned',
  'sponsor.creditPool', 'sponsor.renewalInvite', 'sponsor.toEntityFund', 'sponsor.awaitingDecision', 'sponsor.lateReceived', 'activityFund.received', 'activityFund.reminder', 'activityFund.paid',
  'tax.certificateReady', 'privacy.inactivityNotice', 'account.passkeyAdded', 'support.received', 'support.replied', 'platform.message', 'pledge.charged', 'pledge.skipped', 'pledge.failed',
  'idea.quorumReached', 'idea.centerReplied', 'signer.handover', 'org.kybStatus', 'payout.executed', 'payout.changed', 'initiative.goalReachedSupporter', 'initiative.achievementPhotos',
  'initiative.expiredDecided', 'initiative.resizeClosed', 'initiative.resizePoll', 'initiative.resizeResult', 'initiative.refundingSupporter', 'expired.decisionReminder',
  'event.dateReached', 'event.changed', 'event.cancelledBuyer', 'event.rescheduledBuyer', 'gate.refundedPassUsed'
]);

export function dossierTextsFrom({ dossier, audit, actions, statuses, roles }: DossierTranslators): DossierTexts {
  return {
    t: dossier,
    // El expediente pinta el registro como lo ve una entidad: pedir algo que no existe y pedir algo ajeno se cuentan igual.
    action: (code) => (code === ENTITY_PROBE_ACTION ? audit('entity.probe') : isKnownAuditAction(code) ? actions(code) : audit('list.unknownAction', { code })),
    status: statuses,
    role: roles,
    target: (type) => {
      const key = auditTargetKeyOf(type);
      return key ? audit(`targets.${key}`) : null;
    },
    reason: (code) => audit(`reasons.${code}`),
    actor: (kind) => audit(`actor.${kind}`),
    emailTemplate: (templateKey) => (DOSSIER_EMAIL_TEMPLATE_KEYS.has(templateKey) ? dossier(`emailTemplates.${templateKey}`) : dossier('emailTemplateOther'))
  };
}
