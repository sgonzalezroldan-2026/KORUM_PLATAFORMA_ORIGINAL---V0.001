import type { SplitResolutionInput } from '@/core/admin/console-support-rules';
import type { VerifiedSuperadminActor } from '@/core/security/verified-actor';
import type { Db } from '@/lib/db';
import { ActivityFundError } from '@/core/sponsors/activity-fund-rules';
import { resolveUnknownFundSplit } from '@/services/payments/activity-fund-payout.service';
import { PayoutNotAllowedError, resolveUnknownSplit } from '@/services/payments/split-transfer.service';

/**
 * Repartos de resultado desconocido en la consola (Sprint 5.3, heredado del 2.1 y del 4.2f). Cuando Paycomet no confirma si un reparto salió (red caída,
 * tiempo agotado) el reparto se queda en `SENDING` y **nadie lo reenvía solo**: un reenvío podría pagar dos veces. Una persona comprueba en Paycomet qué pasó
 * y lo resuelve aquí: con el código de autorización del reparto (se hizo) o sin él (no se hizo y vuelve a estar pendiente). Solo se puede resolver un reparto
 * que sigue en `SENDING` (dos resoluciones cruzadas no pagan dos veces) y siempre con el Super-Admin verificado (TOTP de hace menos de 10 minutos).
 */

export interface SplitToResolve {
  kind: 'CAMPAIGN' | 'FUND';
  splitId: number;
  payoutId: number;
  organizationName: string;
  organizationSlug: string;
  amountCents: number;
  /** Referencia del cobro del que sale el reparto en Paycomet (`paycometOrder`) y cuenta destino: lo que hace falta para buscarlo allí. Sin datos personales. */
  paycometOrder: string | null;
  destinationSplitId: string | null;
  sentAt: string | null;
}

const LIMIT = 50;

export async function loadSplitsToResolve(db: Db): Promise<SplitToResolve[]> {
  const [campaign, fund] = await Promise.all([
    db.escrowPayoutSplit.findMany({
      where: { status: 'SENDING' },
      orderBy: { id: 'asc' },
      take: LIMIT,
      select: { id: true, payoutId: true, amountCents: true, sentAt: true, contribution: { select: { paycometOrder: true } }, payout: { select: { destinationSplitId: true, organization: { select: { name: true, slug: true } } } } }
    }),
    db.activityFundSplit.findMany({
      where: { status: 'SENDING' },
      orderBy: { id: 'asc' },
      take: LIMIT,
      select: { id: true, payoutId: true, amountCents: true, sentAt: true, contribution: { select: { paycometOrder: true } }, payout: { select: { destinationSplitId: true, organization: { select: { name: true, slug: true } } } } }
    })
  ]);
  const view = (kind: SplitToResolve['kind'], row: (typeof campaign)[number]): SplitToResolve => ({
    kind,
    splitId: row.id,
    payoutId: row.payoutId,
    organizationName: row.payout.organization.name,
    organizationSlug: row.payout.organization.slug,
    amountCents: row.amountCents,
    paycometOrder: row.contribution.paycometOrder,
    destinationSplitId: row.payout.destinationSplitId,
    sentAt: row.sentAt?.toISOString() ?? null
  });
  return [...campaign.map((row) => view('CAMPAIGN', row)), ...fund.map((row) => view('FUND', row))];
}

export type SplitResolutionResult = { status: 'RESOLVED'; done: boolean } | { status: 'NOT_SENDING' };

/** Resuelve un reparto de resultado desconocido. Un reparto que ya no está en `SENDING` (otra persona lo resolvió antes) responde `NOT_SENDING`, sin cambiar nada. */
export async function resolveSplitToResolve(db: Db, actor: VerifiedSuperadminActor, input: SplitResolutionInput, now: Date = new Date()): Promise<SplitResolutionResult> {
  const resolution = { splitAuthCode: input.splitAuthCode };
  try {
    if (input.kind === 'CAMPAIGN') {
      if ((await db.escrowPayoutSplit.count({ where: { id: input.splitId, status: 'SENDING' } })) === 0) return { status: 'NOT_SENDING' };
      await resolveUnknownSplit(db, actor, input.splitId, resolution, now);
    } else {
      if ((await db.activityFundSplit.count({ where: { id: input.splitId, status: 'SENDING' } })) === 0) return { status: 'NOT_SENDING' };
      await resolveUnknownFundSplit(db, actor, input.splitId, resolution, now);
    }
    return { status: 'RESOLVED', done: input.splitAuthCode !== null };
  } catch (error) {
    // Otra persona resolvió el mismo reparto entre la comprobación y la escritura: la escritura condicional no hizo nada.
    if (error instanceof PayoutNotAllowedError || (error instanceof ActivityFundError && error.reason === 'WRONG_STATUS')) return { status: 'NOT_SENDING' };
    throw error;
  }
}
