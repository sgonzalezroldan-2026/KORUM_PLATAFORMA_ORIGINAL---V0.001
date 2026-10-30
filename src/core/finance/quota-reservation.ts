import { inTransaction, type Db } from '@/lib/db';

/**
 * Reserva reversible de cupos de la entidad (Regla 02 §2, QA-FIN01).
 * Al publicar una campaña (`FUNDRAISING`) se descuentan de la entidad el exento por defecto y la beca de medalla que usa la
 * iniciativa, y se suma su cuota de mantenimiento al acumulado del curso. Si la campaña se cancela o se reembolsa, se
 * devuelve exactamente lo reservado (instantánea `quotaReserved*`), y solo si los cupos siguen siendo del mismo curso.
 *
 * Garantías:
 * - Atómico e idempotente (marcas `quotaReservedAt` / `quotaReleasedAt`).
 * - **Ningún error deja la iniciativa marcada sin el descuento correspondiente**, aunque quien llama capture el error y
 *   confirme su propia transacción: la marca se escribe primero (bloquea la fila de la iniciativa) y se deshace antes de
 *   lanzar cualquier error.
 * - Bloqueo optimista sobre los cupos de la entidad: dos campañas nunca se quedan el mismo cupo.
 */

export class InsufficientQuotaError extends Error {
  constructor(organizationId: string, detail: string) {
    super(`La entidad ${organizationId} no tiene cupo suficiente: ${detail}.`);
    this.name = 'InsufficientQuotaError';
  }
}

export class QuotaConcurrencyError extends Error {
  constructor(organizationId: string) {
    super(`Los cupos de la entidad ${organizationId} cambian a la vez en otra operación; vuelve a intentarlo.`);
    this.name = 'QuotaConcurrencyError';
  }
}

const isQuotaRejection = (error: unknown) => error instanceof InsufficientQuotaError || error instanceof QuotaConcurrencyError;

/** Intentos de la actualización optimista antes de rendirse ante una entidad con mucha concurrencia. */
const MAX_ATTEMPTS = 5;

const QUOTA_FIELDS = {
  organizationId: true,
  defaultExemptAppliedCents: true,
  medalExemptAppliedCents: true,
  maintFeeCents: true,
  quotaReservedAt: true,
  quotaReleasedAt: true,
  quotaReservedExemptCents: true,
  quotaReservedMedalCents: true,
  quotaReservedMaintCents: true,
  quotaReservedPeriod: true
} as const;

const ORG_FIELDS = {
  exemptLimitCents: true,
  exemptRemainingCents: true,
  medalGrantAvailableCents: true,
  medalRank: true,
  maintPaidCents: true,
  maintAnnualCapCents: true,
  quotaPeriod: true
} as const;

type OrgQuotas = { exemptLimitCents: number; exemptRemainingCents: number; medalGrantAvailableCents: number; medalRank: number; maintPaidCents: number; maintAnnualCapCents: number; quotaPeriod: string | null };
type QuotaTarget = { exemptRemainingCents: number; medalGrantAvailableCents: number; maintPaidCents: number };

function assertAmount(initiativeId: number, name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`La iniciativa ${initiativeId} tiene un ${name} no válido: ${String(value)}`);
}

/**
 * Aplica `next` a los cupos de la entidad con bloqueo optimista: solo escribe si siguen valiendo lo que se leyó (en READ
 * COMMITTED, PostgreSQL vuelve a evaluar la condición tras esperar a la otra transacción). `next` puede lanzar para rechazar.
 */
async function updateOrganizationQuotas(tx: Db, organizationId: string, next: (current: OrgQuotas) => QuotaTarget): Promise<OrgQuotas> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const current = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: ORG_FIELDS });
    const target = next(current);
    const { count } = await tx.organization.updateMany({
      where: {
        id: organizationId,
        exemptRemainingCents: current.exemptRemainingCents,
        medalGrantAvailableCents: current.medalGrantAvailableCents,
        maintPaidCents: current.maintPaidCents,
        quotaPeriod: current.quotaPeriod
      },
      data: target
    });
    if (count === 1) return current;
  }
  throw new QuotaConcurrencyError(organizationId);
}

/**
 * Reserva los cupos que usa la iniciativa. Devuelve `reserved: false` si ya estaban reservados (operación repetida).
 * Si la reserva anterior se devolvió (campaña reabierta), vuelve a reservar. Lanza `InsufficientQuotaError` sin cambiar
 * nada si a la entidad ya no le queda cupo.
 */
export async function reserveInitiativeQuotas(db: Db, initiativeId: number): Promise<{ reserved: boolean }> {
  return inTransaction(db, async (tx) => {
    const before = await tx.initiative.findUniqueOrThrow({ where: { id: initiativeId }, select: QUOTA_FIELDS });
    if (before.quotaReservedAt && !before.quotaReleasedAt) return { reserved: false };

    const amounts = { exempt: before.defaultExemptAppliedCents, medal: before.medalExemptAppliedCents, maint: before.maintFeeCents };
    for (const [name, value] of Object.entries(amounts)) assertAmount(initiativeId, name, value);

    // 1. Marca la iniciativa (y bloquea su fila) solo si nadie la ha reservado entre medias.
    const marked = await tx.initiative.updateMany({
      where: { id: initiativeId, quotaReservedAt: before.quotaReservedAt, quotaReleasedAt: before.quotaReleasedAt },
      data: { quotaReservedAt: new Date(), quotaReleasedAt: null, quotaReservedExemptCents: amounts.exempt, quotaReservedMedalCents: amounts.medal, quotaReservedMaintCents: amounts.maint }
    });
    if (marked.count === 0) return { reserved: false };

    // 2. Descuenta de la entidad. Si no se puede, deshace la marca (su fila sigue bloqueada por nosotros) y entonces falla.
    try {
      const org = await updateOrganizationQuotas(tx, before.organizationId, (current) => {
        if (current.exemptRemainingCents < amounts.exempt) {
          throw new InsufficientQuotaError(before.organizationId, `exento disponible ${current.exemptRemainingCents} < ${amounts.exempt} céntimos`);
        }
        if (current.medalGrantAvailableCents < amounts.medal) {
          throw new InsufficientQuotaError(before.organizationId, `beca de medalla disponible ${current.medalGrantAvailableCents} < ${amounts.medal} céntimos`);
        }
        if (current.maintPaidCents + amounts.maint > current.maintAnnualCapCents) {
          throw new InsufficientQuotaError(before.organizationId, `el mantenimiento superaría el tope anual (${current.maintAnnualCapCents} céntimos)`);
        }
        return {
          exemptRemainingCents: current.exemptRemainingCents - amounts.exempt,
          medalGrantAvailableCents: current.medalGrantAvailableCents - amounts.medal,
          maintPaidCents: current.maintPaidCents + amounts.maint
        };
      });
      await tx.initiative.update({ where: { id: initiativeId }, data: { quotaReservedPeriod: org.quotaPeriod } });
    } catch (error) {
      // Un error de la base de datos ya aborta toda la transacción (no se puede confirmar); solo hay que deshacer a mano
      // cuando el rechazo es nuestro y la transacción sigue viva.
      if (!isQuotaRejection(error)) throw error;
      await tx.initiative.update({
        where: { id: initiativeId },
        data: {
          quotaReservedAt: before.quotaReservedAt,
          quotaReleasedAt: before.quotaReleasedAt,
          quotaReservedExemptCents: before.quotaReservedExemptCents,
          quotaReservedMedalCents: before.quotaReservedMedalCents,
          quotaReservedMaintCents: before.quotaReservedMaintCents,
          quotaReservedPeriod: before.quotaReservedPeriod
        }
      });
      throw error;
    }
    return { reserved: true };
  });
}

/**
 * Devuelve a la entidad los cupos reservados por una iniciativa cancelada o reembolsada (`released: false` si ya se
 * devolvieron o nunca se reservaron). Devuelve la instantánea de la reserva, no los importes actuales del presupuesto.
 * Si los cupos de la entidad ya son de otro curso (`credited: false`), la reserva se cierra sin abonar nada: el cupo de un
 * curso pasado no engorda el del nuevo. El exento y la beca nunca superan el límite anual ni la beca de la medalla actual.
 */
export async function releaseInitiativeQuotas(db: Db, initiativeId: number): Promise<{ released: boolean; credited: boolean }> {
  return inTransaction(db, async (tx) => {
    const before = await tx.initiative.findUniqueOrThrow({ where: { id: initiativeId }, select: QUOTA_FIELDS });
    if (!before.quotaReservedAt || before.quotaReleasedAt) return { released: false, credited: false };

    const marked = await tx.initiative.updateMany({
      where: { id: initiativeId, quotaReservedAt: before.quotaReservedAt, quotaReleasedAt: null },
      data: { quotaReleasedAt: new Date() }
    });
    if (marked.count === 0) return { released: false, credited: false };

    // Tope de la beca: la de la medalla actual. Sin configuración para ese rango (tabla aún vacía) no se recorta; aun así
    // nunca se devuelve más de lo que se reservó (instantánea), así que no se puede crear beca de la nada.
    const medalTiers = await tx.medalTierConfig.findMany({ select: { rank: true, grantCents: true } });
    const medalCap = (rank: number) => medalTiers.find((tier) => tier.rank === rank)?.grantCents ?? Number.MAX_SAFE_INTEGER;
    let credited = false;
    try {
      await updateOrganizationQuotas(tx, before.organizationId, (current) => {
        credited = (current.quotaPeriod ?? null) === (before.quotaReservedPeriod ?? null);
        if (!credited) {
          return { exemptRemainingCents: current.exemptRemainingCents, medalGrantAvailableCents: current.medalGrantAvailableCents, maintPaidCents: current.maintPaidCents };
        }
        return {
          exemptRemainingCents: Math.min(current.exemptLimitCents, current.exemptRemainingCents + before.quotaReservedExemptCents),
          medalGrantAvailableCents: Math.min(Math.max(medalCap(current.medalRank), current.medalGrantAvailableCents), current.medalGrantAvailableCents + before.quotaReservedMedalCents),
          maintPaidCents: Math.max(0, current.maintPaidCents - before.quotaReservedMaintCents)
        };
      });
    } catch (error) {
      if (isQuotaRejection(error)) await tx.initiative.update({ where: { id: initiativeId }, data: { quotaReleasedAt: null } });
      throw error;
    }
    return { released: true, credited };
  });
}
