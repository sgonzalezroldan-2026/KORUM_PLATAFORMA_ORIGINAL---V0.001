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

/** Tope del directorio que se carga para el buscador de la portada: con más entidades que esto hará falta un índice de búsqueda. */
export const PUBLIC_DIRECTORY_LIMIT = 2000;

/**
 * Directorio público para el buscador de la portada (Entorno 0): solo nombre, enlace, tipo y provincia de las entidades no archivadas que
 * aceptan aparecer en buscadores (`publicIndexing`). Una entidad que lo desactiva no se lista, aunque su enlace directo siga funcionando.
 */
export async function listPublicDirectory(db: KorumPrismaClient) {
  return db.organization.findMany({
    // Solo entidades verificadas (KYB): un alta recién hecha, sin comprobar, no puede aparecer como «AMPA CEIP Cervantes» (auditoría del 3.2, I2).
    where: { archivedAt: null, publicIndexing: true, kybStatus: 'VERIFIED' },
    select: { slug: true, name: true, vertical: true, province: true, city: true, postalCode: true },
    orderBy: [{ name: 'asc' }, { slug: 'asc' }],
    take: PUBLIC_DIRECTORY_LIMIT
  });
}

/**
 * Eventos de una entidad con la portería abierta (PIN vigente), para la pantalla de entrada de los voluntarios. Solo el título y el
 * identificador: nada del aforo, el dinero ni las personas, que solo ve quien ya ha entrado con el PIN (QA-SEC05).
 */
export async function listGateEvents(db: KorumPrismaClient, slug: string, now: Date = new Date()) {
  return db.initiative.findMany({
    where: { organization: { slug, archivedAt: null }, format: 'TICKETING', gatePinHash: { not: null }, gatePinExpiresAt: { gt: now } },
    select: { id: true, title: true, organization: { select: { id: true, name: true } } },
    orderBy: { gatePinExpiresAt: 'asc' },
    take: 20
  });
}
