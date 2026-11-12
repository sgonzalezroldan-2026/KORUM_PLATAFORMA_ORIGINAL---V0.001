'use client';

import { useTranslations } from 'next-intl';
import { CurrencyText } from '@/components/ui/currency-text';
import { SortableTh } from '@/components/ui/sortable-th';
import type { BiOrganizationRow } from '@/core/finance/bi-aggregate';
import { Link } from '@/i18n/navigation';
import type { SortAccessors } from '@/lib/sort-rows';
import { useSortableRows } from '@/lib/use-sortable-rows';

type Key = 'name' | 'medal' | 'open' | 'closed' | 'sponsors' | 'goal' | 'raised' | 'expectedNet' | 'weightedNet';

const ACCESSORS: SortAccessors<BiOrganizationRow, Key> = {
  name: (row) => row.name,
  medal: (row) => row.medalRank,
  open: (row) => row.openCount,
  closed: (row) => row.completedHistorical,
  sponsors: (row) => row.historicalSponsorsCount,
  goal: (row) => row.potentialGoalCents,
  raised: (row) => row.currentRaisedCents,
  expectedNet: (row) => row.expectedNetCents,
  weightedNet: (row) => row.weightedNetCents
};

const sumOf = (rows: readonly BiOrganizationRow[], pick: (row: BiOrganizationRow) => number) => rows.reduce((total, row) => total + pick(row), 0);

/** Rendimiento por entidad. Cada cabecera ordena de mayor a menor y al revés (`↕`); incluye `Cerradas (Año / Hist.)` y `Comercios (Act. / Hist.)`. */
export function BiOrganizationsTable({ rows: source }: { rows: BiOrganizationRow[] }) {
  const t = useTranslations('admin.orgs');
  const ta = useTranslations('admin');
  const { rows, sort, toggle } = useSortableRows<BiOrganizationRow, Key>(source, ACCESSORS, { key: 'raised', direction: 'desc' });

  if (source.length === 0) return <p className="text-ink-soft">{t('none')}</p>;

  return (
    <>
    <p className="text-sm text-ink-soft xl:hidden">{ta('scrollHint')}</p>
    <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label={t('regionLabel')} data-testid="bi-orgs">
      <table className="w-full min-w-[62rem] border-collapse text-start">
        <caption className="sr-only">{t('caption')}</caption>
        <thead>
          <tr className="border-b-2 border-varsity-navy/20">
            <SortableTh label={t('col.name')} sortKey="name" sort={sort} onToggle={toggle} />
            <SortableTh label={t('col.medal')} sortKey="medal" sort={sort} onToggle={toggle} />
            <SortableTh label={t('col.open')} sortKey="open" sort={sort} onToggle={toggle} align="end" />
            <SortableTh label={t('col.closed')} sortKey="closed" sort={sort} onToggle={toggle} align="end" />
            <SortableTh label={t('col.sponsors')} sortKey="sponsors" sort={sort} onToggle={toggle} align="end" />
            <SortableTh label={t('col.goal')} sortKey="goal" sort={sort} onToggle={toggle} align="end" />
            <SortableTh label={t('col.raised')} sortKey="raised" sort={sort} onToggle={toggle} align="end" />
            <SortableTh label={t('col.expectedNet')} sortKey="expectedNet" sort={sort} onToggle={toggle} align="end" />
            <SortableTh label={t('col.weightedNet')} sortKey="weightedNet" sort={sort} onToggle={toggle} align="end" />
            <th scope="col" className="px-2 py-1 text-start font-corp text-sm font-bold">
              {t('col.manage')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-patio-rule">
          {rows.map((row) => (
            <tr key={row.id} data-org={row.slug}>
              <th scope="row" className="px-2 py-2 text-start font-bold text-varsity-navy">
                {row.name}
                <span className="block text-sm font-normal text-ink-soft">{row.province}</span>
              </th>
              <td className="px-2 py-2">{t(`medal.${row.medalRank}`)}</td>
              <td className="px-2 py-2 text-end font-semibold tabular-nums">{row.openCount}</td>
              <td className="px-2 py-2 text-end tabular-nums">{t('closedValue', { year: row.completedThisYear, historical: row.completedHistorical })}</td>
              <td className="px-2 py-2 text-end tabular-nums">{t('sponsorsValue', { active: row.activeSponsorsCount, historical: row.historicalSponsorsCount })}</td>
              <td className="px-2 py-2 text-end">
                <CurrencyText cents={row.potentialGoalCents} />
              </td>
              <td className="px-2 py-2 text-end text-varsity-emerald">
                <CurrencyText cents={row.currentRaisedCents} className="font-bold" />
              </td>
              <td className={`px-2 py-2 text-end ${row.expectedNetCents < 0 ? 'text-red-800' : ''}`}>
                <CurrencyText cents={row.expectedNetCents} className="font-bold" />
              </td>
              <td className={`px-2 py-2 text-end ${row.weightedNetCents < 0 ? 'text-red-800' : ''}`}>
                <CurrencyText cents={row.weightedNetCents} className="font-bold" />
              </td>
              <td className="px-2 py-2">
                <Link href={`/admin/entidades/${row.id}`} className="inline-flex min-h-11 items-center font-bold text-varsity-navy underline" data-testid="open-360">
                  {t('open360')}
                  <span className="sr-only">{` ${row.name}`}</span>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-varsity-navy bg-varsity-navy text-varsity-ivory" data-row="total">
            <th scope="row" className="px-2 py-2 text-start font-corp font-extrabold">
              {t('total', { count: source.length })}
            </th>
            <td className="px-2 py-2">{t('noValue')}</td>
            <td className="px-2 py-2 text-end tabular-nums">{sumOf(source, (row) => row.openCount)}</td>
            <td className="px-2 py-2 text-end tabular-nums">{t('closedValue', { year: sumOf(source, (row) => row.completedThisYear), historical: sumOf(source, (row) => row.completedHistorical) })}</td>
            <td className="px-2 py-2 text-end tabular-nums">{t('sponsorsValue', { active: sumOf(source, (row) => row.activeSponsorsCount), historical: sumOf(source, (row) => row.historicalSponsorsCount) })}</td>
            <td className="px-2 py-2 text-end">
              <CurrencyText cents={sumOf(source, (row) => row.potentialGoalCents)} />
            </td>
            <td className="px-2 py-2 text-end">
              <CurrencyText cents={sumOf(source, (row) => row.currentRaisedCents)} />
            </td>
            <td className="px-2 py-2 text-end">
              <CurrencyText cents={sumOf(source, (row) => row.expectedNetCents)} />
            </td>
            <td className="px-2 py-2 text-end">
              <CurrencyText cents={sumOf(source, (row) => row.weightedNetCents)} />
            </td>
            <td className="px-2 py-2">{t('noValue')}</td>
          </tr>
        </tfoot>
      </table>
    </div>
    </>
  );
}
