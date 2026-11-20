'use client';

import { useLocale, useTranslations } from 'next-intl';
import { formatCents } from '@/core/finance/money';
import type { VoucherBoard } from '@/core/studio/studio-board';
import { isLocale } from '@/i18n/routing';
import { Row } from './studio-board-row';

/**
 * Pizarra de una venta de vales (Sprint 5.14b): el precio de todos los vales del tope o del objetivo, los gastos de gestión digital **por compra** (con el ejemplo de
 * una compra de 1 vale y de la más grande), la pasarela que esos gastos cubren, el mantenimiento y el neto para la entidad si se vende todo. Como no se sabe cuántas
 * compras habrá, en `INC` el neto es el mínimo de cualquier forma de comprar (la nota lo dice).
 */
export function VoucherRows({ board, mode }: { board: VoucherBoard; mode: 'ADD' | 'INC' }) {
  const t = useTranslations('panel.studio.board');
  const tv = useTranslations('panel.studio.vouchers');
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const money = (cents: number) => formatCents(cents, locale);
  return (
    <div className="flex flex-col gap-2.5" data-testid="studio-voucher-board">
      <Row label={tv(board.capped ? 'boardGross' : 'boardGrossTarget', { count: board.units })} value={money(board.grossCents)} />
      <div className="flex flex-col gap-2 rounded-2xl border border-slate-600 bg-slate-900/60 p-3.5" data-testid="studio-tco-lines">
        <p className="text-xs font-extrabold uppercase text-sky-300">{tv('boardModelTitle')}</p>
        <Row label={tv('boardFee')} value={tv(mode === 'ADD' ? 'boardFeeAdd' : 'boardFeeInc', { amount: money(board.feeOneCents) })} tone="emerald" phrase />
        <Row label={tv('boardFeeLargest', { count: board.largestQuantity })} value={money(board.feeLargestCents)} tone="emerald" />
        <Row label={t('ticketGateway')} value={money(board.totalGatewayCostCents)} />
        <Row label={t('ticketMaint')} value={money(board.maintFeeCents)} tone="sky" />
      </div>
      <div className="border-t border-slate-600 pt-2">
        <Row label={tv(board.capped ? 'boardNet' : 'boardNetTarget')} value={money(board.netCents)} tone="total" />
        <p className="mt-1.5 text-xs text-slate-300" data-testid="studio-voucher-net-note">
          {tv(mode === 'INC' ? 'boardNetNoteInc' : 'boardNetNoteAdd')}
        </p>
      </div>
      {board.maintShortfallCents > 0 ? (
        <p role="status" className="rounded-xl bg-amber-100 p-2.5 text-xs font-semibold text-amber-950">
          {t('maintShortfall', { amount: money(board.maintShortfallCents) })}
        </p>
      ) : null}
      {!board.isGatewayCovered ? (
        <p role="status" className="rounded-xl bg-amber-100 p-2.5 text-xs font-semibold text-amber-950">
          {tv('gatewayNotCovered')}
        </p>
      ) : null}
    </div>
  );
}
