import { releaseInitiativeQuotas } from '@/core/finance/quota-reservation';
import { notifySigners } from '@/core/jobs/notify';
import type { Db } from '@/lib/db';
import { recordStatusChange } from '@/services/audit/status-change-audit';
import { heldMaintenanceCents, type HeldSale } from './held-event';
import { voucherOutcomeAtClose } from './voucher-lifecycle-rules';

/**
 * Una venta de vales que llega a su día de cierre (Sprint 5.14c; decisiones 32 y 66). La lanza `CAMPAIGN_EXPIRY` dentro de su transacción, con la fila bloqueada
 * y ya comprobado que está `FUNDRAISING` y que su cierre ha pasado. Una venta de vales nunca vence ni se devuelve por no llegar a su meta: la meta es orientativa.
 *
 * - **Con algo vendido** (vales o aportaciones «sin producto»): `GOAL_REACHED`, liquidable por lo vendido con la doble firma de siempre. El mantenimiento baja en
 *   proporción a los vales vendidos sobre el tope o el objetivo (decisión 66) y, hasta liquidar, `syncHeldEvent` lo pone al día tras cada devolución de 14 días,
 *   cobro tardío o contracargo. La liquidación espera a que se cierren los 14 días de devolución de todas las compras (`openRefundWindowUntil`).
 * - **Sin nada vendido**: `CANCELLED`, sin dinero que mover, y los cupos vuelven a la entidad. Con un pago en curso (vales retenidos), espera a la ejecución
 *   siguiente: esa persona empezó a pagar antes del cierre y sus vales deben valer.
 * - Los vales vendidos **siguen valiendo** hasta su fecha: el puesto los canjea con la venta cerrada y también ya liquidada.
 * - Una venta de vales nunca lleva Auto-Impulso (Sprint 5.14a): no hay nada que devolver a KORUM.
 */

export interface DueVoucherSale extends HeldSale {
  id: number;
  organizationId: string;
  walletEscrowId: string;
}

export async function closeVoucherSaleAtDate(tx: Db, sale: DueVoucherSale, now: Date): Promise<'SETTLE' | 'CLOSE_EMPTY' | null> {
  const outcome = voucherOutcomeAtClose(sale.raisedCents, sale.ticketsSold);
  if (outcome === 'CLOSE_EMPTY') {
    const paying = await tx.contribution.count({ where: { initiativeId: sale.id, type: 'TICKET', status: 'PENDING', ticketHoldUntil: { gt: now } } });
    if (paying > 0) return null;
  }
  const to = outcome === 'SETTLE' ? 'GOAL_REACHED' : 'CANCELLED';
  const maintFeeCents = outcome === 'SETTLE' ? heldMaintenanceCents(sale) : sale.maintFeeCents;
  const { count } = await tx.initiative.updateMany({ where: { id: sale.id, status: 'FUNDRAISING' }, data: { status: to, stepIndex: outcome === 'SETTLE' ? 5 : 4, maintFeeCents } });
  // Quien llama tiene la fila bloqueada y comprobada: si no cambia, algo va mal.
  if (count !== 1) throw new Error(`La venta de vales ${sale.id} ha cambiado de estado mientras se cerraba.`);
  await recordStatusChange(tx, { initiativeId: sale.id, organizationId: sale.organizationId, from: 'FUNDRAISING', to, reason: 'VOUCHER_SALE_CLOSED' });
  if (outcome === 'CLOSE_EMPTY') await releaseInitiativeQuotas(tx, sale.id);
  await tx.auditLog.create({
    data: {
      actorType: 'SYSTEM',
      organizationId: sale.organizationId,
      action: 'voucher.sale_closed',
      targetType: 'Initiative',
      targetId: String(sale.id),
      metadataJson: { outcome, vouchersSold: sale.ticketsSold, raisedCents: sale.raisedCents, maintFeeCents: outcome === 'SETTLE' ? maintFeeCents : 0 }
    }
  });
  await notifySigners(tx, sale.organizationId, 'voucher.saleClosed', String(sale.id), { initiativeId: sale.id, walletEscrowId: sale.walletEscrowId, outcome, vouchersSold: sale.ticketsSold, raisedCents: sale.raisedCents });
  return outcome;
}
