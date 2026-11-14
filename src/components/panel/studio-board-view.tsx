'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { formatBps, formatCents } from '@/core/finance/money';
import type { ResizedBoard } from '@/core/studio/resized-board';
import type { BudgetBoard, StudioBoard, StudioContext, TicketingBoard } from '@/core/studio/studio-board';
import { isLocale } from '@/i18n/routing';

/**
 * Pizarra TCO del Estudio (`st-tco-budget-panel` y `st-tco-ticketing-panel` del prototipo): la auditoría interna de la entidad, al céntimo. Es la misma
 * pizarra que calcula el servidor (`calculateStudioBudgetTCO`); aquí solo se pinta. Una línea con importe `0` enseña solo `0,00 €`, sin texto de estado
 * (Regla 02 §2). Zona de dinero: azul marino, `tabular-nums` y `Plus Jakarta Sans`. Una campaña rehecha por votación (Sprint 4.4b) enseña sus cifras guardadas
 * (`ResizedRows`): su meta ya no sale de la fórmula y el exento o el «resto sujeto a tramo» no la explicarían.
 */

/**
 * Una línea de la pizarra: rótulo a la izquierda y valor a la derecha. Un importe nunca se parte (el rótulo baja de línea). Un valor que es una frase
 * («0,49 € por unidad (se suman al comprador)», la beca de medalla con su ahorro) lleva `phrase`: si no cabe junto al rótulo baja entero a su propia línea,
 * en vez de dejar al rótulo sin sitio y partirlo letra a letra (repaso del Sprint 5.6).
 */
function Row({ label, value, tone = 'plain', phrase = false }: { label: ReactNode; value: ReactNode; tone?: 'plain' | 'emerald' | 'gold' | 'sky' | 'total'; phrase?: boolean }) {
  const color = { plain: 'text-slate-200', emerald: 'text-emerald-300', gold: 'text-amber-300', sky: 'text-sky-300', total: 'text-amber-300 font-extrabold' }[tone];
  if (phrase) {
    return (
      <div className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-sm ${color}`} data-board-row="phrase">
        <span>{label}</span>
        <span className="ms-auto text-end font-bold tabular-nums text-white">{value}</span>
      </div>
    );
  }
  return (
    <div className={`flex items-baseline justify-between gap-4 text-sm ${color}`} data-board-row="amount">
      <span className="min-w-0 wrap-anywhere">{label}</span>
      <span className="shrink-0 whitespace-nowrap text-end font-bold tabular-nums text-white">{value}</span>
    </div>
  );
}

function BudgetRows({ board, context, contingencyBps }: { board: BudgetBoard; context: StudioContext; contingencyBps: number }) {
  const t = useTranslations('panel.studio.board');
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const money = (cents: number) => formatCents(cents, locale);
  const medal = board.medalExemptCents > 0 && context.medalRank >= 1 && context.medalRank <= 3 ? t(`medal.${context.medalRank}`) : null;
  const detail = board.gatewayDetail;
  const subtotal = board.netCents + board.bracketFeeCents + board.maintFeeCents;

  return (
    <div className="flex flex-col gap-2.5">
      <Row label={t('base')} value={money(board.baseCents)} />
      <Row label={t('contingency', { pct: formatBps(contingencyBps, locale) })} value={`+\u00a0${money(board.contingencyCents)}`} />
      <div className="border-t border-slate-600 pt-2">
        <Row label={t('net')} value={money(board.netCents)} tone="total" />
      </div>
      <div className="flex flex-col gap-2 rounded-2xl border border-slate-600 bg-slate-900/60 p-3.5" data-testid="studio-tco-lines">
        <p className="text-xs font-extrabold uppercase text-slate-300">{t('internalTitle')}</p>
        <Row label={t('line1')} value={t('atZero', { amount: money(board.defaultExemptCents) })} tone="emerald" />
        <Row
          label={t('line2')}
          value={medal ? t('atZeroMedal', { amount: money(board.medalExemptCents), medal, saved: money(board.medalSavedCents) }) : money(board.medalExemptCents)}
          tone="gold"
          phrase={medal !== null}
        />
        {board.categoryExempt ? (
          <Row label={t('line3Exempt')} value={money(0)} />
        ) : (
          <Row label={t('line3', { taxable: money(board.taxableCents), rate: formatBps(board.rateBps, locale) })} value={money(board.bracketFeeCents)} />
        )}
        <Row label={t('line4')} value={money(board.maintFeeCents)} tone="sky" />
        <div className="flex flex-col gap-1 border-t border-slate-600 pt-2">
          <Row label={t('line5')} value={money(board.gatewayFeeCents)} />
          {detail ? (
            <p className="text-xs leading-snug text-slate-300" data-testid="studio-gateway-formula">
              {t('gatewayFormula', {
                pct: formatBps(context.gateway.pctBps, locale),
                subtotal: money(subtotal),
                variable: money(detail.variableCents),
                count: detail.estTransactions,
                ticket: money(context.donationTicketCents),
                fixed: money(context.gateway.fixedCents),
                fixedTotal: money(detail.fixedCents),
                rounding: money(detail.roundingCents),
                net: money(board.netCents),
                fee: money(board.bracketFeeCents),
                maint: money(board.maintFeeCents),
                gateway: money(board.gatewayFeeCents),
                goal: money(board.goalCents)
              })}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Cifras de una campaña rehecha por votación, tal como están guardadas: proyecto + comisiones (+ redondeo) = meta nueva, al céntimo. Si KORUM asume la
 * pasarela se enseña aparte y no entra en la suma. «Para el proyecto al liquidar» solo sale si la campaña se va a liquidar o ya se liquidó (`settles`): una
 * que se está devolviendo no paga nada a la entidad.
 */
function ResizedRows({ board, contingencyBps, settles }: { board: ResizedBoard; contingencyBps: number; settles: boolean }) {
  const t = useTranslations('panel.studio.resized');
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const money = (cents: number) => formatCents(cents, locale);
  const parts = [board.projectCents, board.bracketFeeCents, board.maintFeeCents, ...(board.gatewayAbsorbed ? [] : [board.gatewayFeeCents]), ...(board.roundingCents > 0 ? [board.roundingCents] : [])];

  return (
    <div className="flex flex-col gap-2.5">
      <Row label={t('originalGoal')} value={money(board.originalGoalCents)} />
      <Row label={t('provider')} value={money(board.costMatCents)} />
      <Row label={t('installation')} value={money(board.costInstCents)} />
      <Row label={t('contingency', { pct: formatBps(contingencyBps, locale) })} value={`+\u00a0${money(board.contingencyCents)}`} />
      <div className="border-t border-slate-600 pt-2">
        <Row label={t('project')} value={money(board.projectCents)} tone="total" />
      </div>
      <div className="flex flex-col gap-2 rounded-2xl border border-slate-600 bg-slate-900/60 p-3.5" data-testid="studio-tco-lines">
        <p className="text-xs font-extrabold uppercase text-slate-300">{t('feesTitle')}</p>
        <Row label={t('bracket')} value={money(board.bracketFeeCents)} />
        <Row label={t('maint')} value={money(board.maintFeeCents)} tone="sky" />
        <Row label={t(board.gatewayAbsorbed ? 'gatewayAbsorbed' : 'gateway')} value={money(board.gatewayFeeCents)} />
        {board.roundingCents > 0 ? <Row label={t('rounding')} value={money(board.roundingCents)} tone="emerald" /> : null}
        <p className="border-t border-slate-600 pt-2 text-xs leading-snug text-slate-300" data-testid="studio-resized-sum">
          {t('sum', { parts: parts.map(money).join(' + '), goal: money(board.goalCents) })}
        </p>
      </div>
      {settles ? (
        <div data-testid="studio-resized-entity">
          <Row label={t(board.roundingCents > 0 ? 'entity' : 'entitySame')} value={money(board.entityCents)} tone="emerald" />
        </div>
      ) : null}
    </div>
  );
}

function TicketingRows({ board, mode, subtype }: { board: TicketingBoard; mode: 'ADD' | 'INC'; subtype: 'EVENT' | 'RAFFLE' }) {
  const t = useTranslations('panel.studio.board');
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const money = (cents: number) => formatCents(cents, locale);
  return (
    <div className="flex flex-col gap-2.5">
      <Row label={t(subtype === 'RAFFLE' ? 'ticketGrossRaffle' : 'ticketGross')} value={money(board.grossCents)} />
      <div className="flex flex-col gap-2 rounded-2xl border border-slate-600 bg-slate-900/60 p-3.5" data-testid="studio-tco-lines">
        <p className="text-xs font-extrabold uppercase text-sky-300">{t('ticketModelTitle')}</p>
        <Row label={t('ticketDigitalFee')} value={t(mode === 'ADD' ? 'perUnitAdd' : 'perUnitInc', { amount: money(board.digitalFeeUnitCents) })} tone="emerald" phrase />
        <Row label={t('ticketGateway')} value={money(board.totalGatewayCostCents)} />
        <Row label={t('ticketMaint')} value={money(board.maintFeeCents)} tone="sky" />
      </div>
      <div className="border-t border-slate-600 pt-2">
        <Row label={t('ticketNet')} value={money(board.netCents)} tone="total" />
      </div>
      {board.maintShortfallCents > 0 ? (
        <p role="status" className="rounded-xl bg-amber-100 p-2.5 text-xs font-semibold text-amber-950">
          {t('maintShortfall', { amount: money(board.maintShortfallCents) })}
        </p>
      ) : null}
      {!board.isGatewayCovered ? (
        <p role="status" className="rounded-xl bg-amber-100 p-2.5 text-xs font-semibold text-amber-950">
          {t('gatewayNotCovered', { amount: money(board.marginPerTicketCents) })}
        </p>
      ) : null}
    </div>
  );
}

export interface StudioBoardViewProps {
  board: StudioBoard;
  context: StudioContext;
  contingencyBps: number;
  ticketFeeMode: 'ADD' | 'INC';
  ticketSubtype: 'EVENT' | 'RAFFLE';
  /** Pie con el botón de guardar y publicar. */
  footer?: ReactNode;
  /** Campaña rehecha por votación: sus cifras guardadas sustituyen a la pizarra calculada. */
  resized?: ResizedBoard | null;
  /** La campaña rehecha se liquida o ya se liquidó (conseguida o cerrada): se enseña lo que recibe el proyecto. */
  resizedSettles?: boolean;
}

export function StudioBoardView({ board, context, contingencyBps, ticketFeeMode, ticketSubtype, footer, resized = null, resizedSettles = false }: StudioBoardViewProps) {
  const t = useTranslations('panel.studio.board');
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const badge = resized
    ? t('badgeResized')
    : board.kind === 'TICKETING' ? t('badgeTicketing') : board.categoryExempt ? t('badgeExempt') : board.rateBps > 0 || board.bracketFeeCents > 0 ? t('badgeBracket', { rate: formatBps(board.rateBps, locale) }) : t('badgeExact');

  return (
    <aside aria-label={t('label')} className="korum-trust-vault flex flex-col justify-between gap-5 rounded-3xl bg-varsity-navy p-5 font-corp text-white sm:p-6" data-testid="studio-board">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-600 pb-3">
          <h2 className="text-xs font-extrabold uppercase text-amber-300">{t('title')}</h2>
          <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs font-bold text-emerald-200" data-testid="studio-badge">
            {badge}
          </span>
        </div>
        {resized ? (
          <ResizedRows board={resized} contingencyBps={contingencyBps} settles={resizedSettles} />
        ) : board.kind === 'BUDGET' ? (
          <BudgetRows board={board} context={context} contingencyBps={contingencyBps} />
        ) : (
          <TicketingRows board={board} mode={ticketFeeMode} subtype={ticketSubtype} />
        )}
      </div>
      <div className="flex flex-col gap-3 border-t border-slate-600 pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs font-bold uppercase text-slate-200">{t(resized ? 'goalLabelResized' : board.kind === 'BUDGET' ? 'goalLabel' : 'goalLabelTicketing')}</span>
          <span className="font-corp text-2xl font-extrabold tabular-nums text-amber-400" data-testid="studio-goal">
            {formatCents(resized ? resized.goalCents : board.goalCents, locale)}
          </span>
        </div>
        {footer}
      </div>
    </aside>
  );
}
