import { raiseAlert } from '@/core/jobs/ops-alerts';
import { getAccountBalance } from '@/core/finance/ledger-balances';
import type { JournalLine } from '@/core/finance/ledger-accounts';
import type { Db } from '@/lib/db';
import { RectificationNotAllowedError, rectifyInvoice } from '@/services/invoicing/invoice.service';
import type { InvoicingContext } from './sponsorship-events';

/**
 * Lo propio de deshacer el cobro de un comercio (Sprint 4.2b): su bolsa *Matching 2x* ya en parte liberada, el sobrante de esa bolsa cuando la iniciativa
 * ya se liquidó, las liberaciones que quedan sin respaldo y la factura del fee, que hay que rectificar. Funciones dentro de la transacción de quien llama,
 * que ya tiene la fila de la iniciativa bloqueada.
 */

/** Lo que se deshace de un cobro y, si era una bolsa Matching 2x, cuánto de ella ya habían liberado las donaciones (está en la hucha). */
export interface PayinToUndo {
  lines: JournalLine[];
  poolReleasedCents: number;
}

/**
 * Una bolsa Matching 2x aprobada y en parte liberada ya no está entera en `MATCHING_POOL`: lo liberado pasó a la hucha con cada donación emparejada.
 * Devolverla «línea a línea» cargaría en la bolsa más de lo que queda (saldo negativo). Se carga en la bolsa solo lo que queda y lo liberado sale de la
 * hucha de la iniciativa, que es donde está (heredado del Sprint 3.5, punto 8).
 */
export async function splitReleasedPool(db: Db, lines: JournalLine[]): Promise<PayinToUndo> {
  const poolLine = lines.find((line) => line.account === 'MATCHING_POOL' && line.direction === 'CREDIT');
  if (!poolLine?.sponsorId || !poolLine.initiativeId) return { lines, poolReleasedCents: 0 };
  const { balanceCents } = await getAccountBalance(db, 'MATCHING_POOL', { initiativeId: poolLine.initiativeId, sponsorId: poolLine.sponsorId });
  const remaining = Math.min(Math.max(balanceCents, 0), poolLine.amountCents);
  const released = poolLine.amountCents - remaining;
  if (released === 0) return { lines, poolReleasedCents: 0 };
  const rest = lines.filter((line) => line !== poolLine);
  const split: JournalLine[] = [{ account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: released, organizationId: poolLine.organizationId ?? null, initiativeId: poolLine.initiativeId }];
  if (remaining > 0) split.unshift({ ...poolLine, amountCents: remaining });
  return { lines: [...rest, ...split], poolReleasedCents: released };
}

interface SponsorCharge {
  id: number;
  type: string;
  sponsorId: number | null;
  organizationId: string;
  initiativeId: number;
  totalChargedCents: number;
}

/**
 * Debe del asiento cuando el dinero ya no está en la hucha (iniciativa liquidada o cobro ya devuelto) y lo asume KORUM (`KORUM_LOSS`). Si el cobro era una
 * bolsa Matching 2x con sobrante, ese sobrante **sigue en la bolsa**: sale de `MATCHING_POOL` y solo el resto es pérdida. Si no, la bolsa quedaría como un
 * pasivo sin dueño y, al devolverse o reasignarse (4.2d), el comercio cobraría dos veces (auditoría financiera del 4.2b).
 */
export async function korumLossDebits(tx: Db, contribution: SponsorCharge): Promise<JournalLine[]> {
  const loss = (amountCents: number): JournalLine => ({ account: 'CHARGEBACK_LOSSES', direction: 'DEBIT', amountCents, organizationId: contribution.organizationId });
  if (contribution.type !== 'SPONSORSHIP' || !contribution.sponsorId) return [loss(contribution.totalChargedCents)];
  const { balanceCents } = await getAccountBalance(tx, 'MATCHING_POOL', { initiativeId: contribution.initiativeId, sponsorId: contribution.sponsorId });
  const remaining = Math.min(Math.max(balanceCents, 0), contribution.totalChargedCents);
  if (remaining === 0) return [loss(contribution.totalChargedCents)];
  const pool: JournalLine = { account: 'MATCHING_POOL', direction: 'DEBIT', amountCents: remaining, organizationId: contribution.organizationId, initiativeId: contribution.initiativeId, sponsorId: contribution.sponsorId };
  return remaining === contribution.totalChargedCents ? [pool] : [pool, loss(contribution.totalChargedCents - remaining)];
}

/**
 * Deja sin efecto la bolsa Matching 2x de un comercio cuyo cobro se ha deshecho: la apaga en la iniciativa (si estaba activa) y marca como devueltas sus
 * liberaciones (`MATCHING_FUND`), cuyo dinero ya salió con la devolución del comercio. Así nada las vuelve a sumar ni a deshacer (BI, devoluciones).
 */
export async function retireMatchingPool(tx: Db, sponsor: { id: number; status: string; isMatchingPool: boolean }, initiativeId: number, at: Date): Promise<void> {
  if (!sponsor.isMatchingPool) return;
  if (sponsor.status === 'APPROVED') {
    await tx.initiative.update({ where: { id: initiativeId }, data: { matchingPoolTotalCents: 0, matchingPoolRemainingCents: 0, matchingSponsorName: null } });
  }
  const releases = await tx.ledgerJournal.findMany({
    where: { kind: 'MATCHING_RELEASE', initiativeId, entries: { some: { account: 'MATCHING_POOL', sponsorId: sponsor.id } }, contribution: { status: 'COMPLETED' } },
    select: { contributionId: true }
  });
  for (const { contributionId } of releases) {
    if (contributionId === null) continue;
    const release = await tx.contribution.findUniqueOrThrow({ where: { id: contributionId }, select: { amountCents: true } });
    await tx.contribution.updateMany({ where: { id: contributionId, status: 'COMPLETED' }, data: { status: 'REFUNDED', refundedCents: release.amountCents, refundedAt: at } });
  }
}

/**
 * Rectifica la factura del fee de un patrocinio cuyo cobro se ha devuelto por una vía distinta del rechazo (una devolución hecha desde el panel de Paycomet).
 * Sin los datos del emisor, o si cambió el NIF emisor, la devolución sigue adelante (el dinero ya ha vuelto) y la rectificativa queda pendiente en la consola
 * (`INVOICE_RECTIFY_PENDING`). En un **contracargo** no se rectifica: si el fee sigue siendo ingreso (impago) o se anula lo decide la asesoría fiscal; mientras
 * tanto, la misma alerta.
 */
export async function rectifySponsorFeeAfterReversal(tx: Db, contribution: SponsorCharge, cause: 'REFUND' | 'CHARGEBACK', invoicing: InvoicingContext | undefined, at: Date): Promise<void> {
  if (contribution.type !== 'SPONSORSHIP' || !contribution.sponsorId) return;
  const invoice = await tx.invoice.findFirst({ where: { sponsorId: contribution.sponsorId, invoiceType: 'F1', rectifiedBy: { is: null } }, select: { id: true, invoiceNumber: true } });
  if (!invoice) return;
  if (cause === 'REFUND' && invoicing) {
    try {
      await rectifyInvoice(tx, { invoiceId: invoice.id, issuerTaxId: invoicing.issuerTaxId, issuerName: invoicing.issuerName, keyring: invoicing.keyring, concept: 'Anulación del servicio de gestión publicitaria: patrocinio devuelto' }, at);
      return;
    } catch (error) {
      if (!(error instanceof RectificationNotAllowedError)) throw error;
    }
  }
  await raiseAlert(
    tx,
    {
      type: 'INVOICE_RECTIFY_PENDING',
      severity: 'WARNING',
      dedupeKey: `INVOICE_RECTIFY_PENDING:${invoice.id}`,
      organizationId: contribution.organizationId,
      targetType: 'Invoice',
      targetId: String(invoice.id),
      detail: { invoiceNumber: invoice.invoiceNumber, contributionId: contribution.id, cause }
    },
    at
  );
}
