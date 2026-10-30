import type { KorumPrismaClient } from '@/lib/prisma';
import { ResourceNotFoundError } from './tenant-guard';

/**
 * Lecturas PÚBLICAS (Entorno 1: familias, socios y comercios; no requieren sesión). Solo devuelven campos pensados para
 * ser públicos: nunca CIF, IBAN, correos de los firmantes, correos de las familias ni importes internos de la pizarra.
 * Se identifican por `orgSlug` (público) y solo ven entidades no archivadas.
 */

const PUBLIC_ORGANIZATION_VIEW = {
  id: true,
  slug: true,
  name: true,
  /** Titular legal de los fondos: la información previa al pago debe decir quién recibe el dinero. */
  legalName: true,
  legalForm: true,
  vertical: true,
  province: true,
  medalRank: true,
  brandPrimary: true,
  brandSecondary: true,
  contentLocale: true,
  publicIndexing: true
} as const;

const PUBLIC_INITIATIVE_VIEW = {
  id: true,
  walletEscrowId: true,
  format: true,
  title: true,
  category: true,
  stage: true,
  status: true,
  description: true,
  closesAt: true,
  raisedCents: true,
  goalCents: true,
  totalContributions: true,
  showPublicBreakdown: true,
  matchingPoolRemainingCents: true,
  matchingSponsorName: true,
  ticketSubtype: true,
  ticketPriceCents: true,
  ticketMax: true,
  ticketsSold: true,
  plaqueEnabled: true,
  rewardEnabled: true,
  rewardText: true
} as const;

export async function getPublicOrganization(db: KorumPrismaClient, slug: string) {
  const organization = await db.organization.findFirst({ where: { slug, archivedAt: null }, select: PUBLIC_ORGANIZATION_VIEW });
  if (!organization) throw new ResourceNotFoundError('Entidad');
  return organization;
}

/** Campañas abiertas (`FUNDRAISING`) de la entidad: lo que ven las familias en «Iniciativas y taquilla». */
export async function listPublicInitiatives(db: KorumPrismaClient, slug: string) {
  return db.initiative.findMany({
    where: { status: 'FUNDRAISING', organization: { slug, archivedAt: null } },
    select: PUBLIC_INITIATIVE_VIEW,
    orderBy: [{ closesAt: 'asc' }, { id: 'asc' }]
  });
}

/** Ficha pública de una iniciativa (abierta o ya conseguida). Una iniciativa en preparación o cancelada no es pública. */
export async function getPublicInitiative(db: KorumPrismaClient, slug: string, initiativeId: number) {
  const initiative = await db.initiative.findFirst({
    where: { id: initiativeId, status: { in: ['FUNDRAISING', 'GOAL_REACHED', 'CLOSED'] }, organization: { slug, archivedAt: null } },
    select: PUBLIC_INITIATIVE_VIEW
  });
  if (!initiative) throw new ResourceNotFoundError('Iniciativa');
  return initiative;
}
