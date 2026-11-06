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
  return { organizations, pendingKyb, alerts };
}
