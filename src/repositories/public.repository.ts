import { academicYearFor } from '@/core/finance/academic-year';
import type { KorumPrismaClient } from '@/lib/prisma';
import { ResourceNotFoundError } from './tenant-guard';

/**
 * Lecturas PÚBLICAS (Entorno 1: familias, socios y comercios; no requieren sesión). Solo devuelven campos pensados para
 * ser públicos: nunca CIF, IBAN, correos de los firmantes, correos de las familias ni importes internos de la pizarra.
 * Se identifican por `orgSlug` (público) y solo ven entidades no archivadas.
 */

/** Un fichero solo se enseña si es público y no se ha retirado: del resto ni el identificador sale (Sprint 4.2e). */
const PUBLIC_FILE = { select: { id: true, visibility: true, deletedAt: true } } as const;
export const publicFileId = (file: { id: string; visibility: string; deletedAt: Date | null } | null): string | null => (file && file.visibility === 'PUBLIC' && file.deletedAt === null ? file.id : null);

const PUBLIC_ORGANIZATION_VIEW = {
  id: true,
  slug: true,
  name: true,
  /** Titular legal de los fondos: la información previa al pago debe decir quién recibe el dinero. */
  legalName: true,
  legalForm: true,
  vertical: true,
  province: true,
  city: true,
  postalCode: true,
  medalRank: true,
  brandPrimary: true,
  brandSecondary: true,
  contentLocale: true,
  /** Gastos de gestión digital de la taquilla: tarifa pública, se enseña en la ficha. */
  ticketFeeFixedCents: true,
  ticketFeeBps: true,
  /** Grupos del reto por curso, equipo o grupo (solo sus nombres). */
  participationGroupsJson: true,
  publicIndexing: true,
  updatedAt: true
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
  /** Plazas retenidas por pagos en curso: las libres son `ticketMax − ticketsSold − ticketsHeld`. */
  ticketsHeld: true,
  ticketFeeMode: true,
  ticketVenue: true,
  plaqueEnabled: true,
  rewardEnabled: true,
  rewardText: true,
  targetFamiliesPerCourse: true,
  academicYear: true,
  /** Versiona la tarjeta para WhatsApp: cambia con cada aportación. */
  updatedAt: true,
  translationsJson: true,
  /** Imagen representativa de la campaña (Sprint 4.4c): solo su identificador público, nunca el fichero ni su dueño. */
  coverFile: PUBLIC_FILE,
  courses: { select: { groupName: true, familiesCount: true } }
} as const;

const PUBLIC_STATUSES = ['FUNDRAISING', 'GOAL_REACHED', 'CLOSED'] as const;

export async function getPublicOrganization(db: KorumPrismaClient, slug: string) {
  const organization = await db.organization.findFirst({ where: { slug, archivedAt: null }, select: { ...PUBLIC_ORGANIZATION_VIEW, logoFile: PUBLIC_FILE, bannerFile: PUBLIC_FILE } });
  if (!organization) throw new ResourceNotFoundError('Entidad');
  const { logoFile, bannerFile, ...rest } = organization;
  return { ...rest, logoFileId: publicFileId(logoFile), bannerFileId: publicFileId(bannerFile) };
}

/** Campañas abiertas (`FUNDRAISING`) de la entidad: lo que ven las familias en «Iniciativas y taquilla». */
export async function listPublicInitiatives(db: KorumPrismaClient, slug: string) {
  const rows = await db.initiative.findMany({
    where: { status: 'FUNDRAISING', organization: { slug, archivedAt: null } },
    select: PUBLIC_INITIATIVE_VIEW,
    orderBy: [{ closesAt: 'asc' }, { id: 'asc' }]
  });
  return rows.map(({ coverFile, ...row }) => ({ ...row, coverFileId: publicFileId(coverFile) }));
}

/**
 * Ficha pública de una iniciativa (abierta o ya conseguida). Una iniciativa en preparación o cancelada no es pública. Además de la
 * iniciativa devuelve lo que la ficha necesita de su entidad: el vertical y los grupos (orden del reto por curso) y los gastos de gestión
 * digital de la taquilla, que son una tarifa pública.
 */
export async function getPublicInitiative(db: KorumPrismaClient, slug: string, initiativeId: number) {
  const initiative = await db.initiative.findFirst({
    where: { id: initiativeId, status: { in: [...PUBLIC_STATUSES] }, organization: { slug, archivedAt: null } },
    select: {
      ...PUBLIC_INITIATIVE_VIEW,
      organization: { select: { vertical: true, participationGroupsJson: true, ticketFeeFixedCents: true, ticketFeeBps: true } }
    }
  });
  if (!initiative) throw new ResourceNotFoundError('Iniciativa');
  const { coverFile, ...rest } = initiative;
  return { ...rest, coverFileId: publicFileId(coverFile) };
}

/**
 * Datos mínimos de una iniciativa pública para su tarjeta social (`/api/og/initiative/[id]`), que se pide solo por identificador. Solo
 * iniciativas públicas de entidades no archivadas; cualquier otra devuelve el mismo `404` que una inexistente.
 */
export async function getPublicInitiativeCard(db: KorumPrismaClient, initiativeId: number) {
  const initiative = await db.initiative.findFirst({
    where: { id: initiativeId, status: { in: [...PUBLIC_STATUSES] }, organization: { archivedAt: null } },
    select: {
      id: true,
      title: true,
      format: true,
      status: true,
      raisedCents: true,
      goalCents: true,
      ticketsSold: true,
      ticketsHeld: true,
      ticketMax: true,
      closesAt: true,
      rewardEnabled: true,
      rewardText: true,
      targetFamiliesPerCourse: true,
      updatedAt: true,
      courses: { select: { groupName: true, familiesCount: true } },
      coverFile: PUBLIC_FILE,
      organization: { select: { name: true, brandPrimary: true, brandSecondary: true, logoFile: PUBLIC_FILE } }
    }
  });
  if (!initiative) throw new ResourceNotFoundError('Iniciativa');
  const { logoFile, ...organization } = initiative.organization;
  const { coverFile, ...rest } = initiative;
  return { ...rest, coverFileId: publicFileId(coverFile), organization: { ...organization, logoFileId: publicFileId(logoFile) } };
}

/**
 * Barra de impacto de la portada: lo sumado en el curso vigente entre familias y comercios amigos, y cuántas mejoras se han logrado en total.
 * Son agregados de la entidad, nunca de una persona o un curso.
 */
export async function getPublicImpact(db: KorumPrismaClient, slug: string, now: Date = new Date()) {
  const where = { organization: { slug, archivedAt: null }, status: { in: [...PUBLIC_STATUSES] } };
  const academicYear = academicYearFor(now);
  const [raised, achievements] = await Promise.all([
    db.initiative.aggregate({ where: { ...where, academicYear }, _sum: { raisedCents: true } }),
    db.initiative.count({ where: { organization: where.organization, status: { in: ['GOAL_REACHED', 'CLOSED'] } } })
  ]);
  return { academicYear, raisedCents: raised._sum.raisedCents ?? 0, achievementsCount: achievements };
}

/**
 * Datos internos de la pizarra de una iniciativa pública, **solo para que el servidor derive hechos públicos** (el desglose de 4 líneas que la
 * entidad decide enseñar y el sello «0 % de comisión»). Nunca se reenvían tal cual al navegador ni se mezclan con `listPublicInitiatives`, que
 * devuelve únicamente campos públicos (Regla 01 §4, `tenant-isolation.spec.ts`). Se piden siempre junto a la entidad.
 */
export async function listPricingFacts(db: KorumPrismaClient, slug: string, initiativeIds: readonly number[]) {
  if (initiativeIds.length === 0) return [];
  return db.initiative.findMany({
    where: { id: { in: [...initiativeIds] }, status: { in: [...PUBLIC_STATUSES] }, organization: { slug, archivedAt: null } },
    select: { id: true, costMatCents: true, costInstCents: true, contingencyBps: true, bracketFeeCents: true, maintFeeCents: true, quotaReservedAt: true }
  });
}

/** Lo que decide si una entidad se indexa (`publicIndexing` y KYB verificado). Aparte de la vista pública: el estado del KYB no es público. */
export async function getIndexingFacts(db: KorumPrismaClient, slug: string) {
  const facts = await db.organization.findFirst({ where: { slug, archivedAt: null }, select: { publicIndexing: true, kybStatus: true } });
  if (!facts) throw new ResourceNotFoundError('Entidad');
  return facts;
}

/** Entidades que pueden indexarse (portada pública): no archivadas, con KYB verificado y que no han desactivado `publicIndexing`. */
const INDEXABLE_ORGANIZATION = { archivedAt: null, publicIndexing: true, kybStatus: 'VERIFIED' } as const;

/** Portadas para el sitemap: nunca entra una entidad que desactiva `publicIndexing` (QA-SEO03). */
export async function listIndexableOrganizations(db: KorumPrismaClient) {
  return db.organization.findMany({ where: INDEXABLE_ORGANIZATION, select: { slug: true, updatedAt: true }, orderBy: { slug: 'asc' }, take: PUBLIC_DIRECTORY_LIMIT });
}

/** Iniciativas públicas de entidades indexables, para el sitemap (`FUNDRAISING`, `GOAL_REACHED` y `CLOSED`). */
export async function listIndexableInitiatives(db: KorumPrismaClient) {
  return db.initiative.findMany({
    where: { status: { in: [...PUBLIC_STATUSES] }, organization: INDEXABLE_ORGANIZATION },
    select: { id: true, updatedAt: true, organization: { select: { slug: true } } },
    orderBy: { id: 'asc' },
    take: SITEMAP_INITIATIVES_LIMIT
  });
}

/** Tope del directorio que se carga para el buscador de la portada: con más entidades que esto hará falta un índice de búsqueda. */
export const PUBLIC_DIRECTORY_LIMIT = 2000;
/** Un sitemap admite 50.000 URL; cada iniciativa ocupa 3 (una por idioma). Con más hará falta `generateSitemaps`. */
export const SITEMAP_INITIATIVES_LIMIT = 10_000;

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

/**
 * Pase de entrada para su dueño, desde el enlace del email (`/[orgSlug]/entrada/[passUuid]?sig=…`). Se busca siempre junto a la entidad de la
 * URL: un pase de otra entidad responde igual que uno inexistente. No devuelve el email de quien compró ni el contenido del QR: el QR lo
 * compone la página solo después de comprobar la firma de visualización.
 */
export async function getPassForView(db: KorumPrismaClient, slug: string, passUuid: string) {
  return db.ticketPass.findFirst({
    where: { uuid: passUuid, initiative: { organization: { slug, archivedAt: null } } },
    select: {
      uuid: true,
      serialCode: true,
      subtype: true,
      quantity: true,
      raffleNumbers: true,
      revokedAt: true,
      initiative: { select: { id: true, title: true, ticketVenue: true, closesAt: true, organization: { select: { name: true } } } }
    }
  });
}
