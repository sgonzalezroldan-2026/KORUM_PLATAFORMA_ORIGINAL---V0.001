import { type Db } from '@/lib/db';
import { reverseJournal } from './ledger.service';

/**
 * Devuelve a KORUM el Auto-Impulso de una campaña que fracasa (decisión del promotor, 2026-11-12, opción A de la auditoría financiera del 5.2).
 *
 * El Auto-Impulso es dinero de KORUM, no un cobro a una persona: si la campaña se reabre por un contracargo y vence sin llegar a la meta, a las familias se
 * les devuelve su aportación a su tarjeta, pero ese dinero no tiene a quién devolverse y quedaría atrapado en la hucha (alerta `ESCROW_LEFTOVER`, o mezclado
 * con el proyecto de una votación). Se deshace con el **contra-asiento** de su asiento (`AUTO_BOOST_EXPENSE` ⇄ `INITIATIVE_ESCROW`), la aportación pasa a
 * `REFUNDED` (deja de sumar al Auto-Impulso público) y `raisedCents` baja en lo mismo: lo recaudado vuelve a ser solo dinero de las personas.
 *
 * Se llama dentro de la transacción en que la campaña pasa a `EXPIRED` (`CAMPAIGN_EXPIRY`): por ahí pasan siempre el reembolso del 100 %, la votación de
 * redimensionamiento y su reembolso por falta de proyecto, así que cubre los tres caminos. Es idempotente: la clave del contra-asiento es la del pedido
 * del Auto-Impulso y una aportación ya devuelta no se vuelve a tocar. Devuelve los céntimos devueltos.
 */
export async function returnSelfBoostToKorum(tx: Db, initiativeId: number, now: Date): Promise<number> {
  const boosts = await tx.contribution.findMany({
    where: { initiativeId, type: 'SELF_BOOST', status: 'COMPLETED' },
    select: { id: true, amountCents: true, paycometOrder: true },
    orderBy: { id: 'asc' }
  });
  let returnedCents = 0;
  let returnedCount = 0;
  for (const boost of boosts) {
    const injection = await tx.ledgerJournal.findFirst({ where: { contributionId: boost.id, kind: 'SELF_BOOST_INJECTION' }, select: { id: true } });
    if (!injection) throw new Error(`El Auto-Impulso ${boost.id} no tiene su asiento: no se puede devolver a KORUM.`);
    await reverseJournal(tx, {
      journalId: injection.id,
      idempotencyKey: `selfboost-return:${boost.paycometOrder ?? boost.id}`,
      description: `Devolución a KORUM del Auto-Impulso ${boost.paycometOrder ?? boost.id}: la campaña venció sin llegar a la meta`,
      occurredAt: now
    });
    await tx.contribution.update({ where: { id: boost.id }, data: { status: 'REFUNDED', refundedCents: boost.amountCents, refundedAt: now } });
    returnedCents += boost.amountCents;
    returnedCount += 1;
  }
  // El Auto-Impulso sumó +1 al contador 💛 al ejecutarse: al devolverse, lo quita.
  if (returnedCents > 0) await tx.initiative.update({ where: { id: initiativeId }, data: { raisedCents: { decrement: returnedCents }, totalContributions: { decrement: returnedCount } } });
  return returnedCents;
}
