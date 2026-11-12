import type { Prisma } from '@/generated/prisma/client';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadBiSnapshot, type BiSnapshot } from '@/services/admin/bi-snapshot';
import { loadInitiativePopup, type InitiativePopupView } from '@/services/admin/initiative-popup';
import { listOrganizationsForConsole, loadOrganization360, type Org360View, type OrgListRow } from '@/services/admin/org-360-data';
import { loadPricingHealth, type PricingHealthView } from '@/services/admin/pricing-health-data';
import type { BiFilters } from '@/core/finance/bi-summary';
import { authorizeConsoleSession, requeueTemplateOf } from '@/services/admin/console-alerts.service';
import { authorizeSuperadmin, recordAudit, type SessionActor } from './tenant-guard';

/**
 * Lecturas transversales de la consola del Super-Admin. Cada una pasa por `authorizeSuperadmin` (403 y `AuditLog` a cualquier otra sesión;
 * `superadmin.access` al Super-Admin). La consola completa (BI, ficha 360º, ajustes) llega con los sprints 5.x.
 */

/** Alertas cuyo `targetId` es el identificador de un cobro o de una factura que una persona puede resolver desde la consola. */
const RESOLVABLE_TARGETS = { REFUND_STUCK: 'Contribution', INVOICE_STUCK: 'Invoice' } as const;

export interface ConsoleAlert {
  id: string;
  type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  occurrences: number;
  lastSeenAt: Date;
  organization: { id: string; name: string } | null;
  /** Solo `RECONCILIATION_MISMATCH`: qué descuadre es (`MISSING_LOCALLY`, `AMOUNT_MISMATCH`…). */
  kind: string | null;
  /** Solo `REFUND_STUCK` e `INVOICE_STUCK`: el cobro o la factura que se resuelve a mano. */
  resolvableId: number | null;
  /** Solo `EMAIL_DELIVERY_FAILED` de una plantilla: se pueden volver a poner en cola sus mensajes fallidos (Sprint 5.2). */
  requeueTemplate: string | null;
}

/** Última ejecución de cada tarea programada: tipo, estado, cuándo y cuántos intentos. Sin el texto del error (va en la alerta). */
export interface ConsoleJobRun {
  type: string;
  status: string;
  updatedAt: Date;
  attempts: number;
}

/**
 * Última ejecución de cada tarea. La tabla `Job` crece con cada ejecución: se agrupa en la base de datos (una fila por tipo) y solo se leen esas filas,
 * en vez de traer la tabla entera.
 */
async function loadLatestJobRuns(db: KorumPrismaClient): Promise<ConsoleJobRun[]> {
  const latest = await db.job.groupBy({ by: ['type'], _max: { updatedAt: true } });
  const wanted = latest.flatMap((row) => (row._max.updatedAt ? [{ type: row.type, updatedAt: row._max.updatedAt }] : []));
  if (wanted.length === 0) return [];
  const rows = await db.job.findMany({ where: { OR: wanted }, orderBy: [{ type: 'asc' }, { id: 'desc' }], select: { type: true, status: true, updatedAt: true, attempts: true } });
  // Dos ejecuciones con el mismo instante: se queda la última creada.
  const byType = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!byType.has(row.type)) byType.set(row.type, row);
  return [...byType.values()];
}

function detailKind(detail: Prisma.JsonValue): string | null {
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const kind = detail.kind;
  return typeof kind === 'string' && /^[A-Z_]{1,40}$/.test(kind) ? kind : null;
}

export async function getConsoleOverview(db: KorumPrismaClient, actor: SessionActor) {
  await authorizeSuperadmin(db, actor, 'console.overview', 'Console');
  const [organizations, pendingKyb, rawAlerts, openAlerts, criticalAlerts, jobRuns] = await Promise.all([
    db.organization.count({ where: { archivedAt: null } }),
    db.organization.count({ where: { archivedAt: null, kybStatus: { in: ['PENDING', 'SUBMITTED'] } } }),
    db.opsAlert.findMany({
      where: { status: 'OPEN' },
      orderBy: [{ severity: 'desc' }, { lastSeenAt: 'desc' }],
      take: 50,
      // Solo el tipo, la gravedad, a qué afecta y cuándo: el detalle (importes, códigos) se abre en su ficha.
      select: { id: true, type: true, severity: true, dedupeKey: true, targetType: true, targetId: true, detailJson: true, occurrences: true, lastSeenAt: true, organization: { select: { id: true, name: true } } }
    }),
    db.opsAlert.count({ where: { status: 'OPEN' } }),
    db.opsAlert.count({ where: { status: 'OPEN', severity: 'CRITICAL' } }),
    loadLatestJobRuns(db)
  ]);
  const alerts: ConsoleAlert[] = rawAlerts.map((alert) => {
    const resolvableType = alert.type === 'REFUND_STUCK' || alert.type === 'INVOICE_STUCK' ? RESOLVABLE_TARGETS[alert.type] : null;
    const resolvableId = resolvableType !== null && alert.targetType === resolvableType && alert.targetId !== null && /^\d{1,10}$/.test(alert.targetId) ? Number(alert.targetId) : null;
    return {
      id: alert.id,
      type: alert.type,
      severity: alert.severity,
      occurrences: alert.occurrences,
      lastSeenAt: alert.lastSeenAt,
      organization: alert.organization,
      kind: alert.type === 'RECONCILIATION_MISMATCH' ? detailKind(alert.detailJson) : null,
      resolvableId,
      requeueTemplate: alert.type === 'EMAIL_DELIVERY_FAILED' ? requeueTemplateOf(alert.dedupeKey) : null
    };
  });
  const jobs: ConsoleJobRun[] = jobRuns;
  return { organizations, pendingKyb, alerts, openAlerts, criticalAlerts, jobs, activityFunds: await listActivityFunds(db) };
}

/** Negocio de la consola: ingresos reales (libro mayor) y proyectados, tablas y alertas 💎 / 🚨 (Sprint 5.1). */
export async function getConsoleBusiness(db: KorumPrismaClient, actor: SessionActor, filters: BiFilters): Promise<BiSnapshot> {
  await authorizeSuperadmin(db, actor, 'console.business', 'Console');
  return loadBiSnapshot(db, filters);
}

/** Ficha ejecutiva de una iniciativa (pop-up de las tablas, Sprint 5.2). `null` si no existe. */
export async function getInitiativePopup(db: KorumPrismaClient, actor: SessionActor, initiativeId: number): Promise<InitiativePopupView | null> {
  // Una acción de servidor se puede llamar sin pasar por la página: aquí también se exige el segundo factor de la sesión, no solo en el `layout`.
  await authorizeConsoleSession(db, actor, 'console.initiative_popup', 'Initiative');
  const view = await loadInitiativePopup(db, initiativeId);
  // Qué iniciativa de qué entidad se abrió, no solo que se entró a la consola.
  if (view) await recordAudit(db, actor, { action: 'superadmin.access', organizationId: view.row.organizationId, targetType: 'Initiative', targetId: String(initiativeId), metadata: { operation: 'console.initiative_popup' } }, { required: true });
  return view;
}

/** Entidades de la plataforma para elegir ficha 360º (Sprint 5.2). */
export async function getConsoleOrganizations(db: KorumPrismaClient, actor: SessionActor): Promise<OrgListRow[]> {
  await authorizeSuperadmin(db, actor, 'console.organizations', 'Organization');
  return listOrganizationsForConsole(db);
}

/** Ficha 360º de una entidad: titular, KYB, tarifas, categorías, facturas y negocio. `null` si no existe. Lo abierto queda en la auditoría (`superadmin.access`). */
export async function getOrganization360(db: KorumPrismaClient, actor: SessionActor, organizationId: string): Promise<Org360View | null> {
  await authorizeSuperadmin(db, actor, 'console.organization_360', 'Organization');
  const view = await loadOrganization360(db, organizationId);
  if (view) await recordAudit(db, actor, { action: 'superadmin.access', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { operation: 'console.organization_360' } }, { required: true });
  return view;
}

/** Avisos de las reglas de precio (cabecera de la consola y portada). */
export async function getConsolePricingHealth(db: KorumPrismaClient, actor: SessionActor): Promise<PricingHealthView> {
  await authorizeSuperadmin(db, actor, 'console.pricing_health', 'Console');
  return loadPricingHealth(db);
}

/**
 * Fondos de actividades con dinero o con una liquidación sin terminar (Sprint 4.2f): saldo leído del libro (`ORG_ACTIVITY_FUND`) y estado de su última
 * liquidación abierta. Sin datos de los comercios. Quien llama ya pasó `authorizeSuperadmin`.
 */
async function listActivityFunds(db: KorumPrismaClient) {
  const [entries, open] = await Promise.all([
    db.escrowLedgerEntry.groupBy({ by: ['organizationId', 'direction'], where: { account: 'ORG_ACTIVITY_FUND', organizationId: { not: null } }, _sum: { amountCents: true } }),
    db.activityFundPayout.findMany({ where: { status: { in: ['PENDING_DOUBLE_CHECK', 'APPROVED', 'PROCESSING', 'FAILED'] } }, orderBy: { id: 'desc' }, select: { organizationId: true, status: true, amountCents: true } })
  ]);
  const balance = new Map<string, number>();
  for (const row of entries) {
    if (row.organizationId === null) continue;
    const cents = row._sum.amountCents ?? 0;
    balance.set(row.organizationId, (balance.get(row.organizationId) ?? 0) + (row.direction === 'CREDIT' ? cents : -cents));
  }
  const ids = [...new Set([...[...balance].filter(([, cents]) => cents !== 0).map(([id]) => id), ...open.map((payout) => payout.organizationId)])];
  if (ids.length === 0) return [];
  const organizations = await db.organization.findMany({ where: { id: { in: ids } }, orderBy: { name: 'asc' }, take: 50, select: { id: true, name: true, slug: true } });
  return organizations.map((organization) => {
    const payout = open.find((entry) => entry.organizationId === organization.id) ?? null;
    return { name: organization.name, slug: organization.slug, balanceCents: balance.get(organization.id) ?? 0, openPayout: payout ? { status: payout.status, amountCents: payout.amountCents } : null };
  });
}
