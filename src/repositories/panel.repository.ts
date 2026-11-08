import type { KorumPrismaClient } from '@/lib/prisma';
import { listInitiatives } from './initiative.repository';
import { listSigners } from './organization.repository';
import { authorizeTenant, ResourceNotFoundError, type SessionActor } from './tenant-guard';

/**
 * Lecturas del panel de la entidad (Sprint 4.1): la cabecera de gestión, el cuadro de mandos y el kit de medallas. Cada función autoriza primero
 * (`DIRECTOR` o `COSIGNER` de **esa** entidad, `AuditLog` si se deniega) y elige los campos uno a uno: ni el IBAN, ni el CIF, ni el email o el
 * teléfono de las personas firmantes llegan a estas vistas.
 */

const STAFF = ['DIRECTOR', 'COSIGNER'] as const;

const OVERVIEW_VIEW = {
  id: true,
  slug: true,
  name: true,
  vertical: true,
  walletId: true,
  contactPhone: true,
  kybStatus: true,
  ley49: true,
  ley49VerifiedAt: true,
  exemptLimitCents: true,
  exemptRemainingCents: true,
  medalRank: true,
  medalGrantAvailableCents: true,
  medalGrantUsedInTitle: true,
  completedThisYear: true,
  maintActive: true,
  maintPaidCents: true,
  maintAnnualCapCents: true,
  quotaPeriod: true
} as const;

/** Niveles de medalla de la plataforma (reglas globales de la consola): no son de ninguna entidad, pero solo las leen quienes gestionan una. */
async function loadMedalTiers(db: KorumPrismaClient) {
  return db.medalTierConfig.findMany({ orderBy: { rank: 'asc' }, select: { key: true, name: true, icon: true, rank: true, campaignsRequired: true, grantCents: true } });
}

/** Cabecera de gestión: datos de la entidad, las dos personas firmantes con su cargo y los niveles de medalla. */
export async function getPanelOverview(db: KorumPrismaClient, actor: SessionActor, organizationId: string) {
  await authorizeTenant(db, actor, organizationId, { roles: STAFF, action: 'panel.overview', targetType: 'Organization' });
  const [organization, signers, tiers] = await Promise.all([
    db.organization.findUnique({ where: { id: organizationId }, select: OVERVIEW_VIEW }),
    listSigners(db, actor, organizationId),
    loadMedalTiers(db)
  ]);
  if (!organization) throw new ResourceNotFoundError('Entidad');
  // Primera firma (dirección) antes que la segunda (cofirmante): es el orden en que se firma y en que lo cuenta la pantalla.
  const byRole = (role: string) => (role === 'DIRECTOR' ? 0 : 1);
  return { organization, signers: [...signers].sort((a, b) => byRole(a.role) - byRole(b.role)), tiers };
}

/** Cuadro de mandos: las iniciativas de la entidad (todas, sin PIN de portería) y los comercios activos. */
export async function getDashboardData(db: KorumPrismaClient, actor: SessionActor, organizationId: string, now: Date) {
  const initiatives = await listInitiatives(db, actor, organizationId);
  const activeSponsors = await countActiveSponsors(db, organizationId, now);
  return { initiatives, activeSponsors };
}

/** Comercios amigos activos: cobrados, aprobados por el centro y dentro de su vigencia. */
async function countActiveSponsors(db: KorumPrismaClient, organizationId: string, now: Date): Promise<number> {
  return db.sponsor.count({ where: { organizationId, status: 'APPROVED', paidAt: { not: null }, expiresAt: { gt: now } } });
}

/**
 * Cifras reales para el informe de la medalla: las campañas conseguidas del curso vigente (`quotaPeriod`) con lo recaudado en cada una, y los
 * comercios activos. Lo recaudado sale del contador de la iniciativa, que se actualiza en la misma transacción que el asiento.
 */
export async function getMedalImpact(db: KorumPrismaClient, actor: SessionActor, organizationId: string, now: Date) {
  await authorizeTenant(db, actor, organizationId, { roles: STAFF, action: 'panel.medal_report', targetType: 'Organization' });
  const organization = await db.organization.findUnique({ where: { id: organizationId }, select: { name: true, quotaPeriod: true, medalRank: true } });
  if (!organization) throw new ResourceNotFoundError('Entidad');
  const [achievements, activeSponsors, tiers] = await Promise.all([
    db.initiative.findMany({
      where: { organizationId, status: { in: ['GOAL_REACHED', 'CLOSED'] }, ...(organization.quotaPeriod ? { academicYear: organization.quotaPeriod } : {}) },
      orderBy: { id: 'asc' },
      select: { title: true, raisedCents: true }
    }),
    countActiveSponsors(db, organizationId, now),
    loadMedalTiers(db)
  ]);
  return { organization, achievements, activeSponsors, tiers };
}
