import type { KorumPrismaClient } from '@/lib/prisma';
import { assertInitiativeInOrganization } from './initiative.repository';
import { authorizeTenant, type SessionActor } from './tenant-guard';

/**
 * Aportaciones de una iniciativa para el panel de la entidad. **Sin datos personales**: ni correo ni NIF ni nombre del
 * donante. La entidad ve cuánto, cuándo, por qué medio y desde qué grupo; los certificados fiscales (Sprint 2.3) son un
 * flujo aparte con su propia autorización.
 */

const STAFF = ['DIRECTOR', 'COSIGNER'] as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const CONTRIBUTION_VIEW = {
  id: true,
  type: true,
  groupName: true,
  amountCents: true,
  guaranteeContributionCents: true,
  matchedBonusCents: true,
  totalChargedCents: true,
  paymentMethod: true,
  status: true,
  createdAt: true
} as const;

export async function listContributions(db: KorumPrismaClient, actor: SessionActor, organizationId: string, initiativeId: number, options: { limit?: number } = {}) {
  const proof = await authorizeTenant(db, actor, organizationId, { roles: STAFF, action: 'contribution.list', targetType: 'Initiative', targetId: initiativeId });
  await assertInitiativeInOrganization(db, actor, organizationId, initiativeId, proof);
  const requested = options.limit !== undefined && Number.isFinite(options.limit) ? Math.trunc(options.limit) : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requested, 1), MAX_LIMIT);
  return db.contribution.findMany({
    where: { organizationId, initiativeId },
    select: CONTRIBUTION_VIEW,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit
  });
}
