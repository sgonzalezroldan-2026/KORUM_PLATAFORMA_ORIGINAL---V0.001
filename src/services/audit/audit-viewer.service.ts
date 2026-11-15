import {
  ANONYMOUS_AUTHOR_ACTIONS,
  auditActionsOf,
  auditCategoryOf,
  auditTargetKeyOf,
  AUDIT_ACTIONS,
  ENTITY_PROBE_ACTION,
  ENTITY_VISIBLE_ACTIONS,
  INITIATIVE_TARGET_TYPES,
  isInitiativeStatus,
  isStatusChangeReason,
  PROBE_ACTIONS,
  READ_ACTIONS,
  SECURITY_ACTIONS,
  type AuditCategory,
  type AuditInitiativeStatus,
  type StatusChangeReason
} from '@/core/audit/audit-catalog';
import type { Prisma } from '@/generated/prisma/client';
import type { Db } from '@/lib/db';
import { coarseUserAgent } from '@/repositories/tenant-guard';
import { consoleActor, entityActor, loadAccounts, loadEntityMembers, loadFormerSignerIds, loadKorumPeriods, type AuditActorView, type AuditScope, type KorumPeriods } from './audit-people';
import { auditTargetOf, loadTargetNames, type AuditTargetView } from './audit-targets';
import { sanitizeAuditMetadata } from './audit.service';

/**
 * Lectura de la auditoría para el visor (Sprint 5.8a). Dos alcances y ninguno más:
 *
 * - **Consola** (`console`): todo `AuditLog`, con quién fue (nombre y email de la cuenta, que se buscan al enseñar la página: la auditoría solo guarda su
 *   identificador), desde qué red (los 8 primeros caracteres del HMAC de la IP: sirven para ver que dos filas vienen del mismo sitio, no para saber cuál) y el
 *   detalle guardado, que se vuelve a limpiar antes de enseñarlo.
 * - **Entidad** (`entity`): solo las filas de **su** `organizationId` y solo las acciones de la lista cerrada `ENTITY_VISIBLE_ACTIONS` (sin las consultas de
 *   KORUM, los cambios de la plataforma, las tareas automáticas ni lo que una persona hace con su propia cuenta). No ve el detalle guardado ni la red, y el tipo
 *   de dispositivo solo de sus firmantes y de la portería. Además (auditoría de seguridad del sprint): no distingue un recurso que no existe de uno de otra
 *   entidad; de las consultas de soporte solo ve las dirigidas a ella, nunca las que una familia envía a KORUM; y las lecturas (abrir un documento, descargar un
 *   justificante) solo si las hizo una de sus firmantes, porque las de KORUM serían sus consultas por otra puerta.
 *
 * Quién aparece en cada fila lo decide `audit-people.ts` y sobre qué, `audit-targets.ts`. Quien llama ya ha pasado la guardia (`audit.repository.ts`). Aquí
 * no se escribe nada.
 */

export const AUDIT_PAGE_SIZE = 50;

export type { AuditActorView, AuditScope } from './audit-people';
export { loadEntityMembers } from './audit-people';

export interface AuditFilters {
  category?: AuditCategory | 'unclassified';
  action?: string;
  /** Cuenta que actuó o sobre la que se actuó. */
  personUserId?: string;
  /** Solo en la consola. */
  organizationId?: string;
  initiativeId?: number;
  /** Desde este instante, incluido. */
  from?: Date;
  /** Hasta este instante, sin incluirlo. */
  to?: Date;
  /** Paginación: filas anteriores a este identificador. */
  before?: number;
}

export interface AuditRowView {
  id: number;
  occurredAt: Date;
  action: string;
  category: AuditCategory | null;
  actor: AuditActorView;
  /** Solo en la consola. */
  organization: { id: string; name: string } | null;
  target: AuditTargetView;
  /** Familia del navegador y del sistema (`Chrome/Windows`). En el panel, solo de sus firmantes y de la portería. */
  device: string | null;
  /** Solo en la consola: marca corta de la red. */
  network: string | null;
  statusChange: { from: AuditInitiativeStatus; to: AuditInitiativeStatus; reason: StatusChangeReason | null } | null;
  /** Solo en la consola: el detalle guardado, limpio y aplanado. */
  details: Array<{ key: string; value: string }>;
}

export interface AuditPage {
  rows: AuditRowView[];
  /** Identificador para pedir la página siguiente (`before`), o `null` si no hay más. */
  nextBefore: number | null;
}

const MAX_INT = 2_147_483_647;
const DETAIL_MAX = 240;
const DETAILS_MAX_KEYS = 24;

/**
 * En la consola, las consultas de KORUM (`superadmin.access`) no salen salvo que se pidan con el filtro de tipo o de acción: cada página que abre el
 * Super-Admin deja dos o tres, y sin esto el visor enseñaría sobre todo sus propios pasos. Siguen guardadas y se ven eligiendo «Consultas de KORUM».
 */
export const hidesKorumAccess = (filters: Pick<AuditFilters, 'category' | 'action'>): boolean => filters.category === undefined && filters.action === undefined;

/** Lo que la consulta de la entidad necesita saber de las personas antes de buscar. */
interface EntityPeopleIds {
  memberIds: readonly string[];
  korum: KorumPeriods;
}

function whereOf(scope: AuditScope, filters: AuditFilters, people: EntityPeopleIds): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [];
  if (scope.kind === 'entity') {
    and.push(
      { organizationId: scope.organizationId },
      { action: { in: [...ENTITY_VISIBLE_ACTIONS] } },
      // Solo las consultas de soporte dirigidas a la entidad. Una fila sin ese dato no se enseña (ante la duda, no).
      { OR: [{ action: { not: 'support.ticket_created' } }, { metadataJson: { path: ['target'], equals: 'ORGANIZATION' } }] },
      // Las lecturas, solo si las hizo quien firma hoy por la entidad.
      { OR: [{ action: { notIn: [...READ_ACTIONS] } }, { actorUserId: { in: [...people.memberIds] } }] }
    );
    // Lo que alguien deja **siendo del equipo de KORUM** en la familia de seguridad (un documento que ya no existe, una acción reservada a quien firma) o al
    // leer tampoco se enseña: serían las consultas de KORUM por otra puerta. Se juzga por la fecha de cada fila, no por lo que la cuenta sea hoy.
    const asKorum: Prisma.AuditLogWhereInput[] = [...people.korum].flatMap(([userId, periods]) => periods.map((period) => ({ actorUserId: userId, occurredAt: { gte: period.from, ...(period.to ? { lt: period.to } : {}) } })));
    if (asKorum.length > 0) and.push({ OR: [{ action: { notIn: [...SECURITY_ACTIONS, ...READ_ACTIONS] } }, { actorUserId: null }, { NOT: { OR: asKorum } }] });
  } else {
    if (filters.organizationId) and.push({ organizationId: filters.organizationId });
    if (hidesKorumAccess(filters)) and.push({ action: { notIn: [...auditActionsOf('korumAccess')] } });
  }

  if (filters.category === 'unclassified') and.push({ action: { notIn: [...AUDIT_ACTIONS] } });
  else if (filters.category) and.push({ action: { in: [...auditActionsOf(filters.category)] } });
  // En el panel, filtrar por un sondeo busca los dos: no se distinguen.
  if (filters.action) and.push(scope.kind === 'entity' && PROBE_ACTIONS.includes(filters.action) ? { action: { in: [...PROBE_ACTIONS] } } : { action: filters.action });
  if (filters.personUserId) {
    // En el panel, filtrar por una firmante no trae lo que hizo como familia (una consulta, un voto) ni lo que hizo cuando era del equipo de KORUM: esas
    // filas salen sin su nombre («otra persona», «KORUM»), pero el filtro diría de quién son.
    const asKorum = scope.kind === 'entity' ? (people.korum.get(filters.personUserId) ?? []) : [];
    const acted: Prisma.AuditLogWhereInput =
      scope.kind === 'entity'
        ? {
            actorUserId: filters.personUserId,
            action: { notIn: [...ANONYMOUS_AUTHOR_ACTIONS] },
            ...(asKorum.length > 0 ? { NOT: { OR: asKorum.map((period) => ({ occurredAt: { gte: period.from, ...(period.to ? { lt: period.to } : {}) } })) } } : {})
          }
        : { actorUserId: filters.personUserId };
    and.push({ OR: [acted, { targetType: 'User', targetId: filters.personUserId }] });
  }
  if (filters.initiativeId !== undefined) {
    and.push({
      OR: [
        { targetType: { in: [...INITIATIVE_TARGET_TYPES] }, targetId: String(filters.initiativeId) },
        { metadataJson: { path: ['initiativeId'], equals: filters.initiativeId } }
      ]
    });
  }
  if (filters.from || filters.to) and.push({ occurredAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lt: filters.to } : {}) } });
  if (filters.before !== undefined && Number.isSafeInteger(filters.before) && filters.before > 0 && filters.before <= MAX_INT) and.push({ id: { lt: filters.before } });
  return { AND: and };
}

const deviceOf = (userAgent: string | null): string | null => (!userAgent ? null : /^[A-Za-z]+\/[A-Za-z]+$/.test(userAgent) ? userAgent : coarseUserAgent(userAgent));

function statusChangeOf(action: string, metadata: Prisma.JsonValue): AuditRowView['statusChange'] {
  if (action !== 'initiative.status_changed' || metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const { from, to, reason } = metadata;
  if (!isInitiativeStatus(from) || !isInitiativeStatus(to)) return null;
  return { from, to, reason: isStatusChangeReason(reason) ? reason : null };
}

/** El detalle guardado, vuelto a limpiar (las filas antiguas no pasaron todas por el limpiador) y aplanado a pares de texto. */
export function auditDetailsOf(metadata: Prisma.JsonValue): Array<{ key: string; value: string }> {
  const clean = sanitizeAuditMetadata(metadata);
  if (clean === null || typeof clean !== 'object' || Array.isArray(clean)) return [];
  return Object.entries(clean as Record<string, unknown>)
    .slice(0, DETAILS_MAX_KEYS)
    .map(([key, value]) => {
      const text = value === null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      return { key: key.slice(0, 60), value: text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text };
    });
}

export async function searchAudit(db: Db, scope: AuditScope, filters: AuditFilters): Promise<AuditPage> {
  // En el panel, quienes firman hoy por la entidad se cargan antes: la propia consulta depende de ellos (las lecturas).
  const members = scope.kind === 'entity' ? await loadEntityMembers(db, scope.organizationId) : [];
  const korum: KorumPeriods = scope.kind === 'entity' ? await loadKorumPeriods(db) : new Map();
  const found = await db.auditLog.findMany({
    where: whereOf(scope, filters, { memberIds: members.map((member) => member.userId), korum }),
    orderBy: { id: 'desc' },
    take: AUDIT_PAGE_SIZE + 1,
    select: { id: true, occurredAt: true, actorType: true, actorUserId: true, organizationId: true, action: true, targetType: true, targetId: true, ipHash: true, userAgent: true, metadataJson: true }
  });
  const page = found.slice(0, AUDIT_PAGE_SIZE);
  // Las cuentas que actuaron y, en la consola, también aquellas sobre las que se actuó (para decir de quién es en vez de enseñar su código).
  const userIds = [...new Set(page.flatMap((row) => [...(row.actorUserId ? [row.actorUserId] : []), ...(scope.kind === 'console' && auditTargetKeyOf(row.targetType) === 'User' ? [row.targetId] : [])]))];
  const organizationIds = scope.kind === 'console' ? [...new Set(page.flatMap((row) => (row.organizationId ? [row.organizationId] : [])))] : [];
  const [accounts, organizations, names, former] = await Promise.all([
    loadAccounts(db, userIds),
    organizationIds.length > 0 ? db.organization.findMany({ where: { id: { in: organizationIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    loadTargetNames(db, scope, page),
    scope.kind === 'entity' ? loadFormerSignerIds(db, scope.organizationId, members) : Promise.resolve(new Set<string>())
  ]);
  const organizationById = new Map(organizations.map((organization) => [organization.id, organization]));
  const people = { members: new Map(members.map((member) => [member.userId, member])), former, korum };

  const rows: AuditRowView[] = page.map((row) => {
    const actor = scope.kind === 'console' ? consoleActor(row, accounts) : entityActor(row, people);
    // El panel no distingue «no existe» de «es de otra entidad»: las dos filas salen con la misma acción.
    const action = scope.kind === 'entity' && PROBE_ACTIONS.includes(row.action) ? ENTITY_PROBE_ACTION : row.action;
    return {
      id: row.id,
      occurredAt: row.occurredAt,
      action,
      category: auditCategoryOf(action),
      actor,
      organization: scope.kind === 'console' && row.organizationId ? (organizationById.get(row.organizationId) ?? { id: row.organizationId, name: row.organizationId }) : null,
      target: auditTargetOf(row, scope, accounts, names),
      // En el panel, el dispositivo solo de sus firmantes y de la portería: el de una familia o el del equipo de KORUM no le hace falta.
      device: scope.kind === 'console' || actor.kind === 'member' || actor.kind === 'gate' ? deviceOf(row.userAgent) : null,
      network: scope.kind === 'console' && row.ipHash ? row.ipHash.slice(0, 8) : null,
      statusChange: statusChangeOf(row.action, row.metadataJson),
      details: scope.kind === 'console' ? auditDetailsOf(row.metadataJson) : []
    };
  });
  return { rows, nextBefore: found.length > AUDIT_PAGE_SIZE ? (page[page.length - 1]?.id ?? null) : null };
}

/** Cuenta con ese email, para buscar por persona desde la consola. El email no se guarda ni se anota en ninguna parte: solo se traduce a su identificador. */
export async function findAccountIdByEmail(db: Db, email: string): Promise<string | null> {
  const clean = email.trim().toLowerCase();
  if (clean.length < 3 || clean.length > 320 || !clean.includes('@')) return null;
  return (await db.user.findUnique({ where: { email: clean }, select: { id: true } }))?.id ?? null;
}

/** Nombre y email de una cuenta, para decir en la consola de quién son las filas filtradas. */
export async function describeAccount(db: Db, userId: string): Promise<{ name: string | null; email: string | null; erased: boolean } | null> {
  const account = (await loadAccounts(db, [userId])).get(userId);
  if (!account) return null;
  return account.gdprAnonymizedAt ? { name: null, email: null, erased: true } : { name: account.name || null, email: account.email, erased: false };
}
