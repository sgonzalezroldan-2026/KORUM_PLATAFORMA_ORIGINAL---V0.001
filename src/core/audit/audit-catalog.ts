/**
 * Catálogo de la auditoría (Sprint 5.8a): qué acciones escribe la aplicación en `AuditLog`, a qué familia pertenece cada una y cuáles puede ver una
 * entidad en su panel. Es la única lista: el visor filtra con ella, los textos de `messages/{es,ca,en}.json` (`audit.actions.*`) la siguen una a una
 * (`tests/unit/audit-catalog.spec.ts`) y las pruebas de integración fallan si alguna escribe una acción que no está aquí (`tests/integration/global-setup.ts`).
 * Funciones puras, sin base de datos.
 */

export const AUDIT_CATEGORIES = ['security', 'korumAccess', 'signatures', 'money', 'campaigns', 'ideas', 'gate', 'sponsors', 'entity', 'account', 'support', 'platform', 'system'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** Familias que solo ve KORUM: sus propias consultas a una entidad, los cambios de la plataforma y las tareas automáticas. */
export const CONSOLE_ONLY_CATEGORIES: ReadonlySet<AuditCategory> = new Set(['korumAccess', 'platform', 'system']);

const BY_CATEGORY: Record<AuditCategory, readonly string[]> = {
  security: [
    'tenant.access_denied',
    'tenant.access_denied_over_cap',
    'tenant.resource_not_found',
    'tenant.resource_outside_tenant',
    'auth.sign_in_failed_repeatedly',
    'account.certificate_denied',
    'account.passkey_delete_denied',
    'api.panel_cover_denied',
    'api.panel_dossier_denied',
    'api.panel_entity_image_denied',
    'api.panel_fund_receipt_denied',
    'api.panel_kyb_open_denied',
    'api.panel_kyb_upload_denied',
    'api.panel_logros_denied',
    'api.panel_medalla_denied',
    'api.panel_modelo182_denied',
    'api.panel_payout_invoice_denied',
    'api.panel_payout_invoice_open_denied',
    'api.panel_sponsor_logo_denied',
    'double_check.denied',
    'double_check.otp_locked',
    'double_check.request_rate_limited',
    'double_check.wrong_signer',
    'activity_fund.rate_limited',
    'expired.rate_limited',
    'event.rate_limited',
    'payout.rate_limited',
    'file.not_available',
    'gate.pin_blocked',
    'gate.pin_failed',
    'gate.qr_invalid',
    'gate.qr_other_event',
    'gate.request_limited',
    'gate.session_rejected',
    'voucher.qr_invalid',
    'voucher.qr_other_sale',
    'idea.chat_access_denied',
    'kyb.document_not_found',
    'panel.medal_kit_denied',
    'pledge.access_denied',
    'tax.model182_denied'
  ],
  korumAccess: ['superadmin.access'],
  signatures: [
    'double_check.challenge_issued',
    'double_check.signed',
    'double_check.signature_superseded',
    'signer.cosigner_invitation_corrected',
    'signer.handover_cancelled',
    'signer.handover_completed',
    'signer.handover_proposed',
    'signer.handover_resent',
    'signer.role_label_updated',
    'signer.signature_mode_changed',
    'account.invitation_accepted',
    'organization.resend_invitation'
  ],
  money: [
    'payout.requested',
    'payout.updated',
    'payout.approved',
    'payout.invoice_opened',
    'payout.invoice_uploaded',
    'payout.signatures_rejected',
    'payout.split_resolved',
    'payout.splits_replanned',
    'activity_fund.payout_requested',
    'activity_fund.payout_approved',
    'activity_fund.payout_cancelled',
    'activity_fund.receipt_downloaded',
    'activity_fund.signatures_rejected',
    'activity_fund.split_resolved',
    'payment.chargeback',
    'payment.refund_after_settlement',
    'payment.refund_reactivated',
    'payment.refund_rejected',
    'payment.refund_resolved',
    'payment.refund_unknown',
    'selfboost.executed',
    'invoice.issued',
    'invoice.rectified',
    'invoice.accepted',
    'invoice.rejected',
    'invoice.registration_issue',
    'invoice.registration_resolved',
    'invoice.registration_retry',
    'invoice.registration_unknown',
    'tax.model182_exported',
    'dossier.downloaded',
    'pledge.started',
    'pledge.paused',
    'pledge.resumed',
    'pledge.cancelled',
    'pledge.campaign_changed'
  ],
  campaigns: [
    'initiative.status_changed',
    'initiative.closed',
    'initiative.expired',
    'initiative.refund_decided',
    'initiative.refunded',
    'initiative.resize_vote_launched',
    'initiative.resize_rejected',
    'initiative.resized',
    'initiative.resized_emptied',
    'initiative.resized_rescaled',
    'event.date_reached',
    'event.cancelled',
    'event.rescheduled',
    'event.reschedule_refund',
    'initiative.cover_published',
    'initiative.cover_removed',
    'studio.initiative_saved',
    'studio.initiative_published',
    'studio.draft_discarded',
    'studio.exempt_category_saved',
    'studio.semantic_lock_triggered',
    'studio.semantic_lock_after_publish',
    'resize.link_resent',
    'resize.non_voters_refunded',
    'resize.tallied',
    'resize.vote_option',
    'resize.vote_refund',
    'achievement.photo_published',
    'achievement.thanks_saved'
  ],
  ideas: ['idea.approved', 'idea.converted', 'idea.rejected', 'idea.replied', 'idea.signature_revalidated'],
  gate: ['gate.check_in', 'gate.refunded_pass_used', 'gate.code_rotated', 'gate.pin_revoked', 'gate.pin_set', 'gate.session_opened', 'gate.session_revoked', 'gate.sync', 'voucher.redeemed'],
  sponsors: [
    'sponsor.approved',
    'sponsor.rejected',
    'sponsor.late_charge_pooled',
    'sponsor.logo_published',
    'sponsor.pool_assigned',
    'sponsor.renewal_chained',
    'sponsor.renewal_invited',
    'sponsor.renewal_link_sent',
    'sponsor.renewal_refunded',
    'sponsor.renewal_rule_saved'
  ],
  entity: [
    'organization.registered',
    'organization.branding_updated',
    'organization.category_added',
    'organization.category_rule_set',
    'organization.groups_updated',
    'organization.image_published',
    'organization.image_removed',
    'organization.settings_updated',
    'organization.tariffs_updated',
    'kyb.cif_released',
    'kyb.document_opened',
    'kyb.document_uploaded',
    'kyb.identity_updated',
    'kyb.rejected',
    'kyb.submitted',
    'kyb.verified',
    'panel.medal_kit_downloaded',
    'quota.period_assigned',
    'quota.renewed'
  ],
  account: [
    'account.passkey_added',
    'account.passkey_deleted',
    'privacy.account_name_rectified',
    'privacy.erasure_blocked',
    'privacy.erasure_completed',
    'privacy.export',
    'privacy.request_closed',
    'privacy.request_opened'
  ],
  support: ['support.direct_email_sent', 'support.korum_message_created', 'support.platform_answered', 'support.ticket_answered', 'support.ticket_created'],
  platform: [
    'settings.connection_tested',
    'settings.secret.deleted',
    'settings.secret.updated',
    'settings.setting.cleared',
    'settings.setting.updated',
    'rules.category_added',
    'rules.category_rule_set',
    'rules.global_updated',
    'rules.medals_updated',
    'tariff.negative_return_fixed',
    'superadmin.bootstrapped',
    'superadmin.invitation_cancelled',
    'superadmin.invited',
    'superadmin.revoked',
    'ops_alert.resolved',
    'ops_alert.resolved_with_note',
    'outbox.requeued',
    'PRICING_ALERT_ACKNOWLEDGED'
  ],
  system: ['job.completed', 'job.failed']
};

const CATEGORY_OF = new Map<string, AuditCategory>(AUDIT_CATEGORIES.flatMap((category) => BY_CATEGORY[category].map((action) => [action, category] as const)));

/** Todas las acciones conocidas, en el orden de sus familias. */
export const AUDIT_ACTIONS: readonly string[] = AUDIT_CATEGORIES.flatMap((category) => BY_CATEGORY[category]);

/**
 * Acciones de una **persona** y no de la entidad (auditoría de seguridad del 5.8a): su aportación mensual de Mi Hucha, su cuenta, sus llaves, sus derechos de
 * privacidad y los intentos contra su cuenta. Aunque la fila lleve el identificador de una entidad, esa entidad no las ve: las aportaciones son anónimas (Regla 02)
 * y lo que una familia hace con su cuenta no es asunto de quien firma por el centro.
 */
export const PERSONAL_ACTIONS: readonly string[] = [
  ...BY_CATEGORY.account,
  'pledge.started',
  'pledge.paused',
  'pledge.resumed',
  'pledge.cancelled',
  'pledge.campaign_changed',
  'pledge.access_denied',
  'auth.sign_in_failed_repeatedly',
  'account.certificate_denied',
  'account.passkey_delete_denied'
];

/**
 * Lo que KORUM decide si se cuenta o no (Regla 02 §7): el Auto-Impulso suma como cualquier aportación, pero que se diga que fue KORUM lo decide el
 * Super-Admin en cada ejecución. El registro de la entidad no lo enseña (decisión del promotor del 2026-11-15, tras la revisión de experiencia del 5.8a).
 */
export const KORUM_DISCRETION_ACTIONS: readonly string[] = ['selfboost.executed'];

/**
 * Lo que lleva el identificador de una entidad pero no se le enseña (auditoría de seguridad del 5.8a): el exceso de accesos denegados y el registro en Veri*factu de
 * las facturas que **KORUM** emite a los comercios (aceptaciones, rechazos, incidencias y reintentos). Como los ajustes de la plataforma, solo en la consola.
 */
export const KORUM_INTERNAL_ACTIONS: readonly string[] = [
  // Denegaciones que pasaron del tope de ruido de una entidad (`tenant-guard.ts`): se guardan enteras para la consola.
  'tenant.access_denied_over_cap',
  'invoice.accepted', 'invoice.rejected', 'invoice.registration_issue', 'invoice.registration_resolved', 'invoice.registration_retry', 'invoice.registration_unknown'];

/** Familia de seguridad: en el panel no se enseñan las filas que dejó el equipo de KORUM al consultar (serían sus consultas por otra puerta). */
export const SECURITY_ACTIONS: readonly string[] = BY_CATEGORY.security;

/** Acciones que una entidad puede ver de sí misma: las conocidas, menos las familias que son solo de KORUM y las acciones personales. Lista cerrada: una acción nueva no se enseña hasta clasificarla. */
export const ENTITY_VISIBLE_ACTIONS: readonly string[] = AUDIT_CATEGORIES.filter((category) => !CONSOLE_ONLY_CATEGORIES.has(category))
  .flatMap((category) => BY_CATEGORY[category])
  .filter((action) => !PERSONAL_ACTIONS.includes(action) && !KORUM_DISCRETION_ACTIONS.includes(action) && !KORUM_INTERNAL_ACTIONS.includes(action));

/** Familias que la entidad puede elegir en su filtro: las que le dejan algo que ver. */
export const ENTITY_CATEGORIES: readonly AuditCategory[] = AUDIT_CATEGORIES.filter((category) => BY_CATEGORY[category].some((action) => ENTITY_VISIBLE_ACTIONS.includes(action)));

/** Acciones de una familia que la entidad ve, pero nunca con su autora: la bandeja de soporte del centro contesta sin saber quién escribe, y un voto es de quien donó. */
export const ANONYMOUS_AUTHOR_ACTIONS: ReadonlySet<string> = new Set(['support.ticket_created', 'resize.vote_option', 'resize.vote_refund', 'resize.link_resent']);

/**
 * Lecturas que también puede hacer el Super-Admin (abrir un documento del titular o una factura, descargar un justificante, un expediente, el Modelo 182 o el kit de medallas).
 * La entidad solo las ve cuando las hizo una persona que firma hoy por ella: si no, serían una forma indirecta de ver las consultas de KORUM.
 */
export const READ_ACTIONS: readonly string[] = ['kyb.document_opened', 'payout.invoice_opened', 'activity_fund.receipt_downloaded', 'tax.model182_exported', 'panel.medal_kit_downloaded', 'dossier.downloaded'];

/**
 * Sondeos de recursos. La aplicación responde igual a «no existe» y a «es de otra entidad»; el registro de la entidad tampoco los distingue (los dos salen como
 * `ENTITY_PROBE_ACTION`), o serviría para averiguar qué identificadores existen en otras entidades. La consola sí los ve por separado.
 */
export const PROBE_ACTIONS: readonly string[] = ['tenant.resource_not_found', 'tenant.resource_outside_tenant'];
export const ENTITY_PROBE_ACTION = 'tenant.resource_not_found';

export const isAuditCategory = (value: string): value is AuditCategory => (AUDIT_CATEGORIES as readonly string[]).includes(value);
export const isKnownAuditAction = (action: string): boolean => CATEGORY_OF.has(action);
/** Familia de una acción; `null` si aún no está en el catálogo (el visor de la consola la enseña como «sin clasificar»). */
export const auditCategoryOf = (action: string): AuditCategory | null => CATEGORY_OF.get(action) ?? null;
export const auditActionsOf = (category: AuditCategory): readonly string[] => BY_CATEGORY[category];

/** Forma de una acción que se puede buscar o usar como clave de traducción. */
export const AUDIT_ACTION_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[a-z0-9_]+){0,3}$/;

/**
 * Tipos de objetivo con nombre propio en el visor. La auditoría los ha escrito de dos maneras (`EscrowPayout` y `ESCROW_PAYOUT`): se comparan sin
 * mayúsculas ni guiones bajos. Un tipo que no está aquí se enseña tal cual.
 */
const TARGET_KEYS = [
  'Initiative', 'Organization', 'EscrowPayout', 'ActivityFundPayout', 'Idea', 'IdeaApproval', 'Contribution', 'Sponsor', 'User', 'Passkey', 'Invoice', 'KybDocument', 'FileAsset', 'GateSession',
  'SupportTicket', 'PrivacyRequest', 'SignerHandover', 'ResizePoll', 'WalletSubscription', 'PlatformSetting', 'PlatformSecret', 'GlobalConfig', 'GlobalCategory', 'MedalTier', 'OpsAlert', 'PricingAlert',
  'Job', 'Console', 'Route', 'SuperadminSession', 'Account', 'TicketPass', 'AuditLog', 'OrganizationMember', 'PaymentOrder', 'PaymentMethodToken', 'WebhookEvent', 'MedalTierConfig', 'Gate',
  'EscrowPayoutSplit', 'ActivityFundSplit'
] as const;
export type AuditTargetKey = (typeof TARGET_KEYS)[number];
export const AUDIT_TARGET_KEYS: readonly AuditTargetKey[] = TARGET_KEYS;

const squash = (value: string) => value.replace(/_/g, '').toLowerCase();
const TARGET_BY_SQUASHED = new Map<string, AuditTargetKey>(TARGET_KEYS.map((key) => [squash(key), key]));
export const auditTargetKeyOf = (targetType: string): AuditTargetKey | null => TARGET_BY_SQUASHED.get(squash(targetType)) ?? null;

/** Todas las formas en que la auditoría ha escrito el tipo «iniciativa», para buscar por ella. */
export const INITIATIVE_TARGET_TYPES = ['Initiative', 'INITIATIVE'] as const;

/** Motivos de un cambio de estado de una iniciativa (`initiative.status_changed`). */
export const STATUS_CHANGE_REASONS = [
  'PUBLISHED', 'GOAL_REACHED', 'DEADLINE_PASSED', 'DRAFT_DISCARDED', 'PAYOUT_SENT', 'ENTITY_CHOSE_REFUND', 'RESIZE_VOTE_OPENED', 'RESIZE_VOTE_WITHOUT_PROJECT', 'RESIZE_VOTE_APPROVED',
  'RESIZED_LEFT_EMPTY', 'ALL_REFUNDED', 'REOPENED_BY_REVERSAL', 'EVENT_DATE_REACHED', 'EVENT_CANCELLED', 'EVENT_RESCHEDULED', 'EVENT_EMPTIED'
] as const;
export type StatusChangeReason = (typeof STATUS_CHANGE_REASONS)[number];
export const isStatusChangeReason = (value: unknown): value is StatusChangeReason => typeof value === 'string' && (STATUS_CHANGE_REASONS as readonly string[]).includes(value);

export const INITIATIVE_STATUSES = ['BUDGETING', 'FUNDRAISING', 'GOAL_REACHED', 'CLOSED', 'EXPIRED', 'RESIZE_VOTING', 'REFUNDING', 'REFUNDED', 'CANCELLED'] as const;
export type AuditInitiativeStatus = (typeof INITIATIVE_STATUSES)[number];
export const isInitiativeStatus = (value: unknown): value is AuditInitiativeStatus => typeof value === 'string' && (INITIATIVE_STATUSES as readonly string[]).includes(value);
