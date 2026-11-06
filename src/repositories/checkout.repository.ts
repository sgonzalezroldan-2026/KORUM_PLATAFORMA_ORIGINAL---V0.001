import type { KorumPrismaClient } from '@/lib/prisma';
import { ResourceNotFoundError } from './tenant-guard';

/**
 * Lecturas del checkout de familias (Entorno 1, sin sesión obligatoria). Igual que `public.repository.ts`, se identifican por `orgSlug` y solo
 * ven entidades no archivadas e iniciativas públicas: una iniciativa de otra entidad responde lo mismo que una inexistente. Ninguna devuelve
 * correos, NIF, IBAN ni importes internos de la pizarra; lo que sale de aquí son las condiciones públicas de la compra.
 */

const PUBLIC_STATUSES = ['FUNDRAISING', 'GOAL_REACHED', 'CLOSED'] as const;

/** Lo que el checkout necesita saber de la iniciativa y de su entidad para ofrecer y validar el pago. */
export async function getCheckoutContext(db: KorumPrismaClient, slug: string, initiativeId: number) {
  const [initiative, config] = await Promise.all([
    db.initiative.findFirst({
      where: { id: initiativeId, status: { in: [...PUBLIC_STATUSES] }, organization: { slug, archivedAt: null } },
      select: {
        id: true,
        organizationId: true,
        format: true,
        status: true,
        closesAt: true,
        rewardEnabled: true,
        plaqueEnabled: true,
        ticketSubtype: true,
        ticketMax: true,
        organization: {
          select: {
            name: true,
            /** Titular legal de los fondos: la información previa al pago debe decir quién recibe el dinero. */
            legalName: true,
            vertical: true,
            participationGroupsJson: true,
            ley49: true,
            ley49VerifiedAt: true,
            fullIntegrityCheckCents: true,
            donationPresetsCents: true,
            defaultDonationIdx: true
          }
        }
      }
    }),
    db.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' }, select: { guaranteePresetsCents: true } })
  ]);
  if (!initiative) throw new ResourceNotFoundError('Iniciativa');
  return { ...initiative, guaranteePresetsCents: config.guaranteePresetsCents };
}

export type CheckoutContext = Awaited<ReturnType<typeof getCheckoutContext>>;

/** Aportación pendiente de un pedido para el simulador de pagos (solo `PAYCOMET_MODE=mock`): importe y método, nada de la persona. */
export async function getSimulatedPayment(db: KorumPrismaClient, slug: string, initiativeId: number, order: string) {
  return db.contribution.findFirst({
    where: { paycometOrder: order, initiativeId, type: { in: ['DONATION', 'TICKET', 'SPONSORSHIP'] }, organization: { slug, archivedAt: null } },
    select: { totalChargedCents: true, paymentMethod: true, status: true, type: true }
  });
}

/**
 * Resultado de un pago para la persona que lo hizo (el enlace firmado de vuelta de Paycomet). Devuelve su propia aportación y el avance público
 * de la iniciativa; nunca el email ni el NIF. El pase solo se identifica por su `uuid`: la página compone el enlace firmado de visualización.
 */
export async function getCheckoutResult(db: KorumPrismaClient, slug: string, initiativeId: number, order: string) {
  return db.contribution.findFirst({
    where: { paycometOrder: order, initiativeId, type: { in: ['DONATION', 'TICKET'] }, organization: { slug, archivedAt: null } },
    select: {
      type: true,
      status: true,
      createdAt: true,
      amountCents: true,
      guaranteeContributionCents: true,
      totalChargedCents: true,
      paymentMethod: true,
      groupName: true,
      ticketQuantity: true,
      ticketPass: { select: { uuid: true, serialCode: true, subtype: true, revokedAt: true } },
      initiative: {
        select: {
          id: true,
          title: true,
          translationsJson: true,
          format: true,
          status: true,
          raisedCents: true,
          goalCents: true,
          totalContributions: true,
          ticketMax: true,
          ticketsSold: true,
          rewardEnabled: true,
          targetFamiliesPerCourse: true,
          courses: { select: { groupName: true, familiesCount: true } },
          organization: { select: { name: true, contentLocale: true, vertical: true, participationGroupsJson: true } }
        }
      }
    }
  });
}

export type CheckoutResultRow = NonNullable<Awaited<ReturnType<typeof getCheckoutResult>>>;
