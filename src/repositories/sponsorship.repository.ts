import type { Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { ResourceNotFoundError } from './tenant-guard';

/**
 * Lecturas del patrocinio de comercios (Entorno 1, sin sesión). Como `checkout.repository.ts`, se identifican por `orgSlug` y solo ven entidades
 * no archivadas. El directorio público devuelve únicamente lo que se puede enseñar (nombre, tipo de negocio, categoría y ventaja): nunca el
 * importe, el fee, el CIF, la persona de contacto, el teléfono ni el email. Los documentos del patrocinio solo los lee quien tiene el enlace
 * firmado de su pedido.
 */

/** Comercios amigos visibles: aprobados por el centro y dentro de su vigencia. El orden estricto ORO > PLATA > BRONCE lo aplica quien llama. */
export async function listFriendlySponsors(db: KorumPrismaClient, slug: string, now: Date) {
  return db.sponsor.findMany({
    where: { status: 'APPROVED', expiresAt: { gt: now }, organization: { slug, archivedAt: null } },
    select: { id: true, name: true, sector: true, categoryLevel: true, tierRank: true, promo: true, code: true },
    orderBy: [{ tierRank: 'desc' }, { id: 'asc' }]
  });
}

/** Iniciativa a la que se puede patrocinar ahora: la que antes cierra, entre las que recaudan un presupuesto (no taquilla ni rifa). */
export async function findSponsorableInitiative(db: KorumPrismaClient, slug: string, now: Date) {
  return db.initiative.findFirst({
    where: { status: 'FUNDRAISING', format: 'BUDGET', closesAt: { gt: now }, organization: { slug, archivedAt: null } },
    orderBy: [{ closesAt: 'asc' }, { id: 'asc' }],
    select: { id: true }
  });
}

/**
 * Tiempo que un patrocinio con bolsa Matching 2x **sin pagar** sigue reservando la bolsa: el de la página de pago. Pasado ese plazo, quien abandonó
 * el pago deja de bloquearla (auditoría del Sprint 3.5: nadie puede ocupar la bolsa de una iniciativa sin pagar).
 */
export const MATCHING_POOL_HOLD_MS = 30 * 60_000;

/** `true` si la bolsa Matching 2x de la iniciativa ya está activa o reservada por un comercio que ha pagado o que está pagando ahora. */
export async function isMatchingPoolTaken(db: Db, initiativeId: number, matchingPoolTotalCents: number, now: Date): Promise<boolean> {
  if (matchingPoolTotalCents > 0) return true;
  const holders = await db.sponsor.count({
    where: { initiativeId, isMatchingPool: true, status: { in: ['PENDING', 'APPROVED'] }, OR: [{ paidAt: { not: null } }, { createdAt: { gt: new Date(now.getTime() - MATCHING_POOL_HOLD_MS) } }] }
  });
  return holders > 0;
}

/** Lo que el formulario del comercio necesita y el servidor valida: niveles, fee, si la bolsa Matching 2x está libre y quién recibe el dinero. */
export async function getSponsorshipContext(db: KorumPrismaClient, slug: string, initiativeId: number, now: Date = new Date()) {
  const initiative = await db.initiative.findFirst({
    where: { id: initiativeId, format: 'BUDGET', status: { in: ['FUNDRAISING', 'GOAL_REACHED', 'CLOSED'] }, organization: { slug, archivedAt: null } },
    select: {
      id: true,
      organizationId: true,
      status: true,
      closesAt: true,
      matchingPoolTotalCents: true,
      organization: { select: { name: true, legalName: true, sponsorTiersCents: true, sponsorFeeBps: true } }
    }
  });
  if (!initiative) throw new ResourceNotFoundError('Iniciativa');
  return { ...initiative, matchingPoolTaken: await isMatchingPoolTaken(db, initiative.id, initiative.matchingPoolTotalCents, now) };
}

export type SponsorshipContext = Awaited<ReturnType<typeof getSponsorshipContext>>;

/** Pedido pendiente de un patrocinio, para el simulador de pagos: importe y método, nada del comercio. */
export async function getSponsorshipResult(db: KorumPrismaClient, slug: string, initiativeId: number, order: string) {
  return db.contribution.findFirst({
    where: { paycometOrder: order, initiativeId, type: 'SPONSORSHIP', organization: { slug, archivedAt: null } },
    select: {
      status: true,
      createdAt: true,
      amountCents: true,
      totalChargedCents: true,
      paymentMethod: true,
      sponsor: { select: { name: true, categoryLevel: true, isMatchingPool: true, status: true, autoRenew: true } },
      initiative: { select: { id: true, title: true, translationsJson: true, raisedCents: true, goalCents: true, totalContributions: true, organization: { select: { name: true, contentLocale: true } } } }
    }
  });
}

/** Todo lo que llevan el justificante y la factura de un patrocinio. El CIF sigue cifrado: la página lo abre en servidor para su titular. */
export async function getSponsorshipDocuments(db: KorumPrismaClient, slug: string, order: string) {
  return db.contribution.findFirst({
    where: { paycometOrder: order, type: 'SPONSORSHIP', status: { in: ['COMPLETED', 'REFUND_PENDING', 'REFUNDED'] }, organization: { slug, archivedAt: null } },
    select: {
      id: true,
      organizationId: true,
      amountCents: true,
      totalChargedCents: true,
      status: true,
      createdAt: true,
      paymentMethod: true,
      organization: { select: { name: true, legalName: true } },
      initiative: { select: { id: true, title: true } },
      sponsor: {
        select: {
          id: true,
          name: true,
          cifEnc: true,
          cifKeyVersion: true,
          categoryLevel: true,
          isMatchingPool: true,
          feeGeneratedCents: true,
          invoices: { select: { invoiceNumber: true, issuedAt: true, issuerTaxId: true, baseAmountCents: true, taxRateBps: true, taxAmountCents: true, totalAmountCents: true, verifactuHash: true, verifactuQrUrl: true, verifactuStatus: true, concept: true }, orderBy: { id: 'asc' }, take: 1 }
        }
      }
    }
  });
}

export type SponsorshipDocuments = NonNullable<Awaited<ReturnType<typeof getSponsorshipDocuments>>>;
