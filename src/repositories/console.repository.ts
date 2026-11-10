import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeSuperadmin, type SessionActor } from './tenant-guard';

/**
 * Lecturas transversales de la consola del Super-Admin. Cada una pasa por `authorizeSuperadmin` (403 y `AuditLog` a cualquier otra sesión;
 * `superadmin.access` al Super-Admin). La consola completa (BI, ficha 360º, ajustes) llega con los sprints 5.x.
 */
export async function getConsoleOverview(db: KorumPrismaClient, actor: SessionActor) {
  await authorizeSuperadmin(db, actor, 'console.overview', 'Console');
  const [organizations, pendingKyb, alerts] = await Promise.all([
    db.organization.count({ where: { archivedAt: null } }),
    db.organization.count({ where: { archivedAt: null, kybStatus: { in: ['PENDING', 'SUBMITTED'] } } }),
    db.opsAlert.findMany({
      where: { status: 'OPEN' },
      orderBy: [{ severity: 'desc' }, { lastSeenAt: 'desc' }],
      take: 50,
      // Solo el tipo, la gravedad, a qué afecta y cuándo: el detalle (importes, códigos) se abre en su ficha.
      select: { id: true, type: true, severity: true, targetType: true, occurrences: true, lastSeenAt: true, organization: { select: { name: true } } }
    })
  ]);
  return { organizations, pendingKyb, alerts, activityFunds: await listActivityFunds(db) };
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
