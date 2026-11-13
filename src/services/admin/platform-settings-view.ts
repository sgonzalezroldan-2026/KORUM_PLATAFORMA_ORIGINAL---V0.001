import { listPendingSuperadminInvitations } from '@/core/onboarding/invitations';
import { countPendingRotation } from '@/core/security/key-rotation';
import {
  LEGAL_DOCUMENTS,
  LEGAL_LOCALES,
  legalKeyOf,
  SECTION_FIELDS,
  SETTINGS_SECTIONS,
  type LegalDocument,
  type LegalLocale
} from '@/core/admin/settings-model';
import type { Db } from '@/lib/db';
import {
  ACTIVITY_FUND_RULE,
  AUTH_EMAIL_RULE,
  AUTH_SECOND_FACTOR_FAILURE_RULE,
  CHECKOUT_RULE,
  GATE_ENTRY_RULE,
  REGISTRATION_RULE,
  SIGNATURE_REQUEST_RULE,
  WEBHOOK_INVALID_RULE
} from '@/lib/rate-limit-rules';
import type { SettingsRuntime } from './settings-runtime';
import { describeSecrets, type SecretSummary } from '@/services/settings/settings.service';
import { settingDefinition, SECRET_DEFINITIONS, type SecretKey } from '@/services/settings/setting-definitions';

/**
 * Lo que enseña `/admin/ajustes` (Sprint 5.4). Lee la base directamente (sin la caché de 30 s del servicio de ajustes: quien edita tiene que ver lo último guardado y su versión).
 * Nunca devuelve el valor de un secreto, solo su pista de 4 caracteres, y de los textos legales manda a la pantalla solo la lista (versión, estado y tamaño) y el texto elegido.
 */

export type SettingSource = 'console' | 'env' | 'default' | 'none';

export interface SettingFieldView {
  value: unknown;
  /** Versión guardada (0 si el ajuste no tiene fila en la consola): el formulario la devuelve al guardar. */
  version: number;
  source: SettingSource;
}

export interface LegalOverviewRow {
  document: LegalDocument;
  locale: LegalLocale;
  version: string | null;
  status: 'BORRADOR' | 'PUBLICADO' | null;
  characters: number;
  settingVersion: number;
}

export interface LegalSelected {
  document: LegalDocument;
  locale: LegalLocale;
  settingVersion: number;
  text: { version: string; status: 'BORRADOR' | 'PUBLICADO'; markdown: string } | null;
}

export interface TeamMember {
  id: string;
  email: string;
  twoFactorEnabled: boolean;
  isYou: boolean;
  lastSeenAt: Date | null;
}

export interface TeamInvitation {
  userId: string;
  email: string;
  expiresAt: Date;
  expired: boolean;
}

export interface SecurityView {
  keyVersion: number;
  previousKeys: number;
  pending: Record<string, number>;
  pendingTotal: number;
  alerts: Record<'CARD_DELETE_FAILED' | 'PRIVACY_REQUEST_OVERDUE' | 'ENCRYPTION_KEY_MISSING', number>;
}

export interface HistoryRow {
  id: number;
  occurredAt: Date;
  action: string;
  target: string;
  actorEmail: string | null;
  version: number | null;
  /** Valor guardado, solo si es corto y no personal (el catálogo marca qué ajustes se pueden copiar a la auditoría). */
  value: string | null;
  legal: { version: string; status: string } | null;
  status: string | null;
  sessionsClosed: number | null;
  /** Se marcó la confirmación del proveedor y de la revisión legal al activar el monedero con saldo. */
  walletConfirmed: boolean;
}

export interface FixedLimit {
  id: string;
  limit: number;
  windowMs: number;
}

export interface SettingsView {
  paycometMode: 'mock' | 'sandbox' | 'live';
  fields: Record<string, SettingFieldView>;
  secrets: Record<string, SecretSummary>;
  legal: { overview: LegalOverviewRow[]; selected: LegalSelected; policyVersion: string };
  team: { members: TeamMember[]; invitations: TeamInvitation[] };
  security: SecurityView;
  history: { rows: HistoryRow[]; hasMore: boolean; limit: number };
  fixedLimits: FixedLimit[];
}

const FIXED_LIMITS: ReadonlyArray<{ id: string; rule: { limit: number; windowMs: number | null } }> = [
  { id: 'authEmail', rule: AUTH_EMAIL_RULE },
  { id: 'secondFactorFailures', rule: AUTH_SECOND_FACTOR_FAILURE_RULE },
  { id: 'registration', rule: REGISTRATION_RULE },
  { id: 'checkout', rule: CHECKOUT_RULE },
  { id: 'signatureRequests', rule: SIGNATURE_REQUEST_RULE },
  { id: 'gateEntry', rule: GATE_ENTRY_RULE },
  { id: 'activityFund', rule: ACTIVITY_FUND_RULE },
  { id: 'webhookInvalid', rule: WEBHOOK_INVALID_RULE }
];

export const HISTORY_ACTIONS = [
  'settings.setting.updated',
  'settings.setting.cleared',
  'settings.secret.updated',
  'settings.secret.deleted',
  'settings.connection_tested',
  'superadmin.invited',
  'superadmin.invitation_cancelled',
  'superadmin.revoked'
] as const;

export const HISTORY_PAGE = 25;
export const HISTORY_MAX = 200;

const ALL_FIELD_KEYS = SETTINGS_SECTIONS.flatMap((section) => SECTION_FIELDS[section].map((field) => field.key));
const ALL_SECRET_KEYS = Object.keys(SECRET_DEFINITIONS) as SecretKey[];
const ALERT_TYPES = ['CARD_DELETE_FAILED', 'PRIVACY_REQUEST_OVERDUE', 'ENCRYPTION_KEY_MISSING'] as const;

const asStatus = (value: unknown): 'BORRADOR' | 'PUBLICADO' | null => (value === 'BORRADOR' || value === 'PUBLICADO' ? value : null);

async function loadFields(db: Db, fallbacks: Readonly<Record<string, string | undefined>>): Promise<Record<string, SettingFieldView>> {
  const rows = await db.platformSetting.findMany({ where: { key: { in: ALL_FIELD_KEYS } }, select: { key: true, valueJson: true, version: true } });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const fields: Record<string, SettingFieldView> = {};
  for (const key of ALL_FIELD_KEYS) {
    const row = byKey.get(key);
    const definition = settingDefinition(key);
    const envValue = definition.envFallback ? fallbacks[definition.envFallback]?.trim() : undefined;
    fields[key] = row
      ? { value: row.valueJson, version: row.version, source: 'console' }
      : envValue
        ? { value: envValue, version: 0, source: 'env' }
        : definition.defaultValue !== undefined
          ? { value: definition.defaultValue, version: 0, source: 'default' }
          : { value: null, version: 0, source: 'none' };
  }
  return fields;
}

async function loadLegal(db: Db, selected: { document: LegalDocument; locale: LegalLocale }): Promise<SettingsView['legal']> {
  const keys = LEGAL_DOCUMENTS.flatMap((document) => LEGAL_LOCALES.map((locale) => legalKeyOf(document, locale)));
  const rows = await db.platformSetting.findMany({ where: { key: { in: keys } }, select: { key: true, valueJson: true, version: true } });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const overview: LegalOverviewRow[] = LEGAL_DOCUMENTS.flatMap((document) =>
    LEGAL_LOCALES.map((locale) => {
      const row = byKey.get(legalKeyOf(document, locale));
      const value = row?.valueJson as { version?: unknown; status?: unknown; markdown?: unknown } | undefined;
      return { document, locale, version: typeof value?.version === 'string' ? value.version : null, status: asStatus(value?.status), characters: typeof value?.markdown === 'string' ? value.markdown.length : 0, settingVersion: row?.version ?? 0 };
    })
  );
  const row = byKey.get(legalKeyOf(selected.document, selected.locale));
  const value = row?.valueJson as { version: string; status: 'BORRADOR' | 'PUBLICADO'; markdown: string } | undefined;
  const policy = await db.platformSetting.findUnique({ where: { key: 'privacy.policyVersion' }, select: { valueJson: true } });
  return {
    overview,
    selected: { ...selected, settingVersion: row?.version ?? 0, text: value ? { version: value.version, status: value.status, markdown: value.markdown } : null },
    policyVersion: (policy?.valueJson as string | undefined) ?? (settingDefinition('privacy.policyVersion').defaultValue as string)
  };
}

async function loadTeam(db: Db, actorUserId: string): Promise<SettingsView['team']> {
  const [admins, pending] = await Promise.all([
    db.user.findMany({ where: { isSuperadmin: true, gdprAnonymizedAt: null }, orderBy: { email: 'asc' }, select: { id: true, email: true, twoFactorEnabled: true } }),
    listPendingSuperadminInvitations(db)
  ]);
  const seen = await db.session.groupBy({ by: ['userId'], where: { userId: { in: admins.map((admin) => admin.id) } }, _max: { updatedAt: true } });
  const invited = pending.length > 0 ? await db.user.findMany({ where: { id: { in: pending.map((item) => item.userId) } }, select: { id: true, email: true } }) : [];
  return {
    members: admins.map((admin) => ({ ...admin, isYou: admin.id === actorUserId, lastSeenAt: seen.find((item) => item.userId === admin.id)?._max.updatedAt ?? null })),
    invitations: pending.flatMap((item) => {
      const user = invited.find((candidate) => candidate.id === item.userId);
      return user ? [{ userId: item.userId, email: user.email, expiresAt: item.expiresAt, expired: item.expired }] : [];
    })
  };
}

async function loadSecurity(db: Db, runtime: SettingsRuntime): Promise<SecurityView> {
  const [pending, grouped] = await Promise.all([
    countPendingRotation(db, runtime.keyring),
    db.opsAlert.groupBy({ by: ['type'], where: { status: 'OPEN', type: { in: [...ALERT_TYPES] } }, _count: { _all: true } })
  ]);
  const alerts = { CARD_DELETE_FAILED: 0, PRIVACY_REQUEST_OVERDUE: 0, ENCRYPTION_KEY_MISSING: 0 };
  for (const row of grouped) if (row.type in alerts) alerts[row.type as keyof typeof alerts] = row._count._all;
  return { keyVersion: runtime.encryptionKeyVersion, previousKeys: runtime.previousKeyCount, pending, pendingTotal: Object.values(pending).reduce((sum, count) => sum + count, 0), alerts };
}

const shortValue = (metadata: Record<string, unknown>): string | null => {
  const value = metadata.newSetting;
  if (typeof value === 'string') return value.length <= 80 ? value : null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
};

async function loadHistory(db: Db, limit: number): Promise<SettingsView['history']> {
  const rows = await db.auditLog.findMany({ where: { action: { in: [...HISTORY_ACTIONS] } }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: limit + 1, select: { id: true, occurredAt: true, action: true, targetId: true, actorUserId: true, metadataJson: true } });
  const page = rows.slice(0, limit);
  const actorIds = [...new Set(page.flatMap((row) => (row.actorUserId ? [row.actorUserId] : [])))];
  const actors = actorIds.length > 0 ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } }) : [];
  return {
    hasMore: rows.length > limit,
    limit,
    rows: page.map((row) => {
      const metadata = (row.metadataJson && typeof row.metadataJson === 'object' && !Array.isArray(row.metadataJson) ? row.metadataJson : {}) as Record<string, unknown>;
      const legal = typeof metadata.legalVersion === 'string' ? { version: metadata.legalVersion, status: typeof metadata.legalStatus === 'string' ? metadata.legalStatus : '' } : null;
      return {
        id: row.id,
        occurredAt: row.occurredAt,
        action: row.action,
        target: row.targetId,
        actorEmail: actors.find((actor) => actor.id === row.actorUserId)?.email ?? null,
        version: typeof metadata.version === 'number' ? metadata.version : null,
        value: legal ? null : shortValue(metadata),
        legal,
        status: typeof metadata.status === 'string' ? metadata.status : null,
        sessionsClosed: typeof metadata.sessionsClosed === 'number' ? metadata.sessionsClosed : null,
        walletConfirmed: metadata.walletLegalConfirmed === true
      };
    })
  };
}

export interface SettingsViewOptions {
  actorUserId: string;
  text?: { document: LegalDocument; locale: LegalLocale };
  historyLimit?: number;
}

export async function loadSettingsView(db: Db, runtime: SettingsRuntime, options: SettingsViewOptions): Promise<SettingsView> {
  const historyLimit = Math.min(Math.max(options.historyLimit ?? HISTORY_PAGE, HISTORY_PAGE), HISTORY_MAX);
  const [fields, secretList, legal, team, security, history] = await Promise.all([
    loadFields(db, runtime.fallbacks ?? process.env),
    describeSecrets(db, ALL_SECRET_KEYS, runtime.fallbacks ?? process.env),
    loadLegal(db, options.text ?? { document: 'terminos', locale: 'es' }),
    loadTeam(db, options.actorUserId),
    loadSecurity(db, runtime),
    loadHistory(db, historyLimit)
  ]);
  const secrets = Object.fromEntries(secretList.map((secret) => [secret.key, secret]));
  return {
    paycometMode: runtime.paycometMode,
    fields,
    secrets,
    legal,
    team,
    security,
    history,
    fixedLimits: FIXED_LIMITS.map(({ id, rule }) => ({ id, limit: rule.limit, windowMs: rule.windowMs ?? 0 }))
  };
}
