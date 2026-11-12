'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { CurrencyText } from '@/components/ui/currency-text';
import { SortableTh } from '@/components/ui/sortable-th';
import { StatusBadge } from '@/components/ui/status-badge';
import { type BiInitiativeRow } from '@/core/finance/bi-aggregate';
import { type BiStatusFilter, filterByStatus } from '@/core/finance/bi-summary';
import type { SortAccessors } from '@/lib/sort-rows';
import { useSortableRows } from '@/lib/use-sortable-rows';
import { InitiativeDiagnosis } from './initiative-diagnosis';
import { InitiativePopup } from './initiative-popup';

type Key = 'wallet' | 'title' | 'organization' | 'closesAt' | 'status' | 'goal' | 'raised' | 'contributions' | 'progress' | 'net' | 'weightedNet';

const ACCESSORS: SortAccessors<BiInitiativeRow, Key> = {
  wallet: (row) => row.walletEscrowId,
  title: (row) => row.title,
  organization: (row) => row.organizationName,
  closesAt: (row) => row.closesAt,
  status: (row) => STATUS_ORDER.indexOf(row.status),
  goal: (row) => row.goalCents,
  raised: (row) => row.raisedCents,
  contributions: (row) => row.totalContributions,
  progress: (row) => row.progressPct,
  net: (row) => row.netRevenueCents,
  weightedNet: (row) => row.weightedNetCents
};

const TOP_COUNT = 10;
/** Orden del ciclo de vida: el «Estado» se ordena como lo lee una persona, no por su código interno. */
const STATUS_ORDER = ['FUNDRAISING', 'GOAL_REACHED', 'CLOSED', 'EXPIRED', 'RESIZE_VOTING', 'REFUNDING', 'REFUNDED', 'BUDGETING', 'CANCELLED'];
const ROW_TONE = (row: BiInitiativeRow) => `cursor-pointer hover:bg-amber-50 ${row.isNegativeReturnAlert ? 'bg-red-50' : ''}`;

/**
 * Top 10 y listado global de iniciativas. Las dos tablas ordenan por cualquier columna (`↕`): el top 10 ordena **todas** las filtradas y se
 * queda con las 10 primeras, como el prototipo. Lleva siempre `💛 Aportaciones` y el diagnóstico 💎 / 🚨 de cada iniciativa.
 */
export function BiInitiativesTables({ rows, truncated, showTop10 = true }: { rows: BiInitiativeRow[]; truncated: boolean; showTop10?: boolean }) {
  const t = useTranslations('admin.initiatives');
  const ta = useTranslations('admin');
  const format = useFormatter();
  const statusId = useId();
  const [status, setStatus] = useState<BiStatusFilter>('ALL');
  const [openId, setOpenId] = useState<number | null>(null);

  const top = useSortableRows<BiInitiativeRow, Key>(rows, ACCESSORS, { key: 'raised', direction: 'desc' });
  const listed = useMemo(() => filterByStatus(rows, status), [rows, status]);
  const global = useSortableRows<BiInitiativeRow, Key>(listed, ACCESSORS, { key: 'raised', direction: 'desc' });
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeZone: 'Europe/Madrid' });

  return (
    <div className="flex flex-col gap-8">
      {truncated ? (
        <p role="status" className="rounded-xl bg-amber-100 p-3 text-amber-950" data-testid="bi-truncated">
          {t('truncated')}
        </p>
      ) : null}

      {showTop10 ? (
      <section aria-labelledby="top10-title" className="flex flex-col gap-3" data-testid="bi-top10">
        <div>
          <h3 id="top10-title" className="font-corp text-xl font-extrabold text-varsity-navy">
            {t('top10Title')}
          </h3>
          <p className="text-sm text-ink-soft">{t('top10Hint')}</p>
        </div>
        {rows.length === 0 ? (
          <p className="text-ink-soft">{t('none')}</p>
        ) : (
          <>
          <p className="text-sm text-ink-soft xl:hidden">{ta('scrollHint')}</p>
          <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label={t('top10Region')}>
            <table className="w-full min-w-[66rem] border-collapse text-start">
              <caption className="sr-only">{t('top10Caption')}</caption>
              <thead>
                <tr className="border-b-2 border-varsity-navy/20">
                  <th scope="col" className="px-2 py-1 text-start font-corp text-sm font-bold">
                    {t('col.position')}
                  </th>
                  <SortableTh label={t('col.title')} sortKey="title" sort={top.sort} onToggle={top.toggle} />
                  <SortableTh label={t('col.organization')} sortKey="organization" sort={top.sort} onToggle={top.toggle} />
                  <SortableTh label={t('col.closesAt')} sortKey="closesAt" sort={top.sort} onToggle={top.toggle} />
                  <SortableTh label={t('col.goal')} sortKey="goal" sort={top.sort} onToggle={top.toggle} align="end" />
                  <SortableTh label={t('col.raised')} sortKey="raised" sort={top.sort} onToggle={top.toggle} align="end" />
                  <SortableTh label={t('col.contributions')} columnName={t('col.contributionsName')} sortKey="contributions" sort={top.sort} onToggle={top.toggle} align="end" />
                  <SortableTh label={t('col.progress')} sortKey="progress" sort={top.sort} onToggle={top.toggle} align="end" />
                  <SortableTh label={t('col.net')} sortKey="net" sort={top.sort} onToggle={top.toggle} align="end" />
                  <SortableTh label={t('col.weightedNet')} sortKey="weightedNet" sort={top.sort} onToggle={top.toggle} align="end" />
                  <th scope="col" className="px-2 py-1 text-start font-corp text-sm font-bold">
                    {t('col.diagnosis')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-patio-rule">
                {top.rows.slice(0, TOP_COUNT).map((row, index) => (
                  <tr key={row.id} className={ROW_TONE(row)} data-initiative={row.id} onClick={() => setOpenId(row.id)}>
                    <td className="px-2 py-2 font-extrabold tabular-nums text-ink-soft">{index + 1}</td>
                    <th scope="row" className="min-w-44 px-2 py-2 text-start font-bold text-varsity-navy">
                      <button type="button" onClick={() => setOpenId(row.id)} aria-haspopup="dialog" className="min-h-11 text-start font-bold underline decoration-varsity-navy/40 underline-offset-2 hover:decoration-varsity-navy" data-testid="open-popup">
                        {row.title}
                        <span className="sr-only"> {t('openPopup')}</span>
                      </button>
                    </th>
                    <td className="px-2 py-2">{row.organizationName}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{date(row.closesAt)}</td>
                    <td className="px-2 py-2 text-end">
                      <CurrencyText cents={row.goalCents} />
                    </td>
                    <td className="px-2 py-2 text-end text-varsity-emerald">
                      <CurrencyText cents={row.raisedCents} className="font-bold" />
                    </td>
                    <td className="px-2 py-2 text-end font-extrabold tabular-nums">
                      <span aria-hidden="true">{'💛 '}</span>
                      {row.totalContributions}
                    </td>
                    <td className="px-2 py-2 text-end font-bold tabular-nums">{t('percent', { value: row.progressPct })}</td>
                    <td className={`px-2 py-2 text-end ${row.netRevenueCents < 0 ? 'text-red-800' : ''}`}>
                      <CurrencyText cents={row.netRevenueCents} className="font-bold" />
                    </td>
                    <td className={`px-2 py-2 text-end ${row.weightedNetCents < 0 ? 'text-red-800' : ''}`}>
                      <CurrencyText cents={row.weightedNetCents} className="font-bold" />
                    </td>
                    <td className="min-w-56 px-2 py-2">
                      <InitiativeDiagnosis row={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </section>
      ) : null}

      <section aria-labelledby="global-title" className="flex flex-col gap-3" data-testid="bi-global">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 id="global-title" className="font-corp text-xl font-extrabold text-varsity-navy">
              {t('globalTitle')}
            </h3>
            <p className="text-sm text-ink-soft">{t('globalHint')}</p>
          </div>
          <label htmlFor={statusId} className="flex min-w-0 max-w-full flex-col gap-1 text-sm font-semibold text-ink-soft">
            {t('statusFilter')}
            <select id={statusId} value={status} onChange={(event) => setStatus(event.target.value as BiStatusFilter)} className="min-h-11 w-full min-w-0 max-w-full rounded-lg border-2 border-varsity-navy/30 bg-white px-3 text-base text-ink">
              <option value="ALL">{t('statusAll')}</option>
              <option value="ACTIVE">{t('statusActive')}</option>
              <option value="FINISHED">{t('statusFinished')}</option>
            </select>
          </label>
        </div>
        {listed.length === 0 ? (
          <p className="text-ink-soft">{t('none')}</p>
        ) : (
          <>
          <p className="text-sm text-ink-soft xl:hidden">{ta('scrollHint')}</p>
          <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label={t('globalRegion')}>
            <table className="w-full min-w-[66rem] border-collapse text-start">
              <caption className="sr-only">{t('globalCaption')}</caption>
              <thead>
                <tr className="border-b-2 border-varsity-navy/20">
                  <SortableTh label={t('col.wallet')} sortKey="wallet" sort={global.sort} onToggle={global.toggle} />
                  <SortableTh label={t('col.title')} sortKey="title" sort={global.sort} onToggle={global.toggle} />
                  <SortableTh label={t('col.organization')} sortKey="organization" sort={global.sort} onToggle={global.toggle} />
                  <SortableTh label={t('col.status')} sortKey="status" sort={global.sort} onToggle={global.toggle} />
                  <SortableTh label={t('col.goal')} sortKey="goal" sort={global.sort} onToggle={global.toggle} align="end" />
                  <SortableTh label={t('col.raised')} sortKey="raised" sort={global.sort} onToggle={global.toggle} align="end" />
                  <SortableTh label={t('col.contributions')} columnName={t('col.contributionsName')} sortKey="contributions" sort={global.sort} onToggle={global.toggle} align="end" />
                  <SortableTh label={t('col.net')} sortKey="net" sort={global.sort} onToggle={global.toggle} align="end" />
                  <th scope="col" className="px-2 py-1 text-start font-corp text-sm font-bold">
                    {t('col.diagnosis')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-patio-rule">
                {global.rows.map((row) => (
                  <tr key={row.id} className={ROW_TONE(row)} data-initiative={row.id} onClick={() => setOpenId(row.id)}>
                    <td className="px-2 py-2 font-mono text-sm text-ink-soft">{row.walletEscrowId}</td>
                    <th scope="row" className="min-w-44 px-2 py-2 text-start font-bold text-varsity-navy">
                      <button type="button" onClick={() => setOpenId(row.id)} aria-haspopup="dialog" className="min-h-11 text-start font-bold underline decoration-varsity-navy/40 underline-offset-2 hover:decoration-varsity-navy" data-testid="open-popup">
                        {row.title}
                        <span className="sr-only"> {t('openPopup')}</span>
                      </button>
                    </th>
                    <td className="px-2 py-2">{`${row.organizationName} (${row.province})`}</td>
                    <td className="px-2 py-2">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-2 py-2 text-end">
                      <CurrencyText cents={row.goalCents} />
                    </td>
                    <td className="px-2 py-2 text-end text-varsity-emerald">
                      <CurrencyText cents={row.raisedCents} className="font-bold" />
                    </td>
                    <td className="px-2 py-2 text-end font-extrabold tabular-nums">
                      <span aria-hidden="true">{'💛 '}</span>
                      {row.totalContributions}
                    </td>
                    <td className={`px-2 py-2 text-end ${row.netRevenueCents < 0 ? 'text-red-800' : ''}`}>
                      <CurrencyText cents={row.netRevenueCents} className="font-bold" />
                    </td>
                    <td className="min-w-56 px-2 py-2">
                      <InitiativeDiagnosis row={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </section>
      <InitiativePopup initiativeId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
