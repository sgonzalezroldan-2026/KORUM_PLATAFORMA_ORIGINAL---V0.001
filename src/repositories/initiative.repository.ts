import type { InitiativeStatus } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { requireOwnedResource } from './ownership';
import { authorizeTenant, ResourceNotFoundError, type AccessDecision, type SessionActor } from './tenant-guard';

/** Iniciativas de una entidad, para quien la gestiona. El PIN de portería (`gatePinHash`) no forma parte de ninguna vista. */

const STAFF = ['DIRECTOR', 'COSIGNER'] as const;

const INITIATIVE_VIEW = {
  id: true,
  organizationId: true,
  walletEscrowId: true,
  format: true,
  academicYear: true,
  title: true,
  category: true,
  stage: true,
  status: true,
  stepIndex: true,
  closesAt: true,
  firstPayinAt: true,
  raisedCents: true,
  goalCents: true,
  totalContributions: true,
  costMatCents: true,
  costInstCents: true,
  contingencyBps: true,
  showPublicBreakdown: true,
  defaultExemptAppliedCents: true,
  medalExemptAppliedCents: true,
  medalRankApplied: true,
  bracketRateAppliedBps: true,
  bracketFeeCents: true,
  maintFeeCents: true,
  gatewayFeeCents: true,
  absorbsGatewayCostByKorum: true,
  matchingPoolTotalCents: true,
  matchingPoolRemainingCents: true,
  ticketSubtype: true,
  ticketPriceCents: true,
  ticketMax: true,
  ticketsSold: true,
  ticketFeeMode: true,
  description: true,
  createdAt: true
} as const;

export interface InitiativeFilter {
  status?: readonly InitiativeStatus[];
}

export async function listInitiatives(db: KorumPrismaClient, actor: SessionActor, organizationId: string, filter: InitiativeFilter = {}) {
  await authorizeTenant(db, actor, organizationId, { roles: STAFF, action: 'initiative.list', targetType: 'Initiative' });
  return db.initiative.findMany({
    // `organizationId` va siempre en la consulta: aunque faltara la guardia, no saldría nada de otra entidad.
    where: { organizationId, ...(filter.status ? { status: { in: [...filter.status] } } : {}) },
    select: INITIATIVE_VIEW,
    orderBy: { id: 'asc' }
  });
}

/**
 * Comprueba que la iniciativa es de la entidad (404 uniforme si no; registra el intento). Exige la decisión de acceso que
 * devuelve `authorizeTenant` como «prueba» de que quien llama ya pasó la guardia: así no se puede usar para sondear identificadores.
 */
export async function assertInitiativeInOrganization(
  db: KorumPrismaClient,
  actor: SessionActor,
  organizationId: string,
  initiativeId: number,
  _proof: AccessDecision & { allowed: true }
): Promise<void> {
  const owner = await db.initiative.findUnique({ where: { id: initiativeId }, select: { organizationId: true } });
  await requireOwnedResource(db, actor, { organizationId, resourceType: 'Initiative', resourceId: initiativeId, resourceLabel: 'Iniciativa', ownerOrganizationId: owner?.organizationId ?? null });
}

export async function getInitiative(db: KorumPrismaClient, actor: SessionActor, organizationId: string, initiativeId: number) {
  const proof = await authorizeTenant(db, actor, organizationId, { roles: STAFF, action: 'initiative.get', targetType: 'Initiative', targetId: initiativeId });
  await assertInitiativeInOrganization(db, actor, organizationId, initiativeId, proof);
  const initiative = await db.initiative.findFirst({ where: { id: initiativeId, organizationId }, select: INITIATIVE_VIEW });
  if (!initiative) throw new ResourceNotFoundError('Iniciativa');
  return initiative;
}
