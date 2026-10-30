import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeTenant, type SessionActor } from './tenant-guard';

/** Comercios amigos e ideas de una entidad, para quien la gestiona. */

const STAFF = ['DIRECTOR', 'COSIGNER'] as const;

const SPONSOR_VIEW = {
  id: true,
  initiativeId: true,
  name: true,
  cif: true,
  contactPerson: true,
  phone: true,
  email: true,
  sector: true,
  categoryLevel: true,
  amountCents: true,
  feeGeneratedCents: true,
  isMatchingPool: true,
  autoRenew: true,
  status: true,
  paidAt: true,
  expiresAt: true
} as const;

export async function listSponsors(db: KorumPrismaClient, actor: SessionActor, organizationId: string) {
  await authorizeTenant(db, actor, organizationId, { roles: STAFF, action: 'sponsor.list', targetType: 'Sponsor' });
  return db.sponsor.findMany({ where: { organizationId }, select: SPONSOR_VIEW, orderBy: { id: 'asc' } });
}

/**
 * Las ideas se muestran con su alias anónimo (`Código #FAM-XXXX`): el correo de quien la propone
 * (`authorCanonicalEmail`) no forma parte de la vista, ni siquiera para quien gestiona la entidad.
 */
const IDEA_VIEW = {
  id: true,
  alias: true,
  title: true,
  category: true,
  description: true,
  phase: true,
  votes: true,
  verifiedVotes: true,
  suspiciousVotes: true,
  expiresAt: true,
  createdAt: true
} as const;

export async function listIdeas(db: KorumPrismaClient, actor: SessionActor, organizationId: string) {
  await authorizeTenant(db, actor, organizationId, { roles: STAFF, action: 'idea.list', targetType: 'Idea' });
  return db.idea.findMany({ where: { organizationId }, select: IDEA_VIEW, orderBy: { id: 'asc' } });
}
