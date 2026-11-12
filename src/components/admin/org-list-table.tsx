'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { SortableTh } from '@/components/ui/sortable-th';
import { Link } from '@/i18n/navigation';
import type { SortAccessors } from '@/lib/sort-rows';
import { useSortableRows } from '@/lib/use-sortable-rows';
import type { OrgListRow } from '@/services/admin/org-360-data';

type Key = 'name' | 'province' | 'kyb' | 'submitted' | 'medal';
const KYB_ORDER = ['SUBMITTED', 'REJECTED', 'PENDING', 'VERIFIED'];
const ACCESSORS: SortAccessors<OrgListRow, Key> = {
  name: (row) => row.name,
  province: (row) => row.province,
  kyb: (row) => KYB_ORDER.indexOf(row.kybStatus),
  submitted: (row) => row.kybSubmittedAt ?? '',
  medal: (row) => row.medalRank
};
const DATE = { dateStyle: 'medium', timeZone: 'Europe/Madrid' } as const;

/** Todas las entidades: cada cabecera ordena de mayor a menor y al revés (`↕`) y cada fila lleva a su ficha 360º. */
export function OrgListTable({ rows: source }: { rows: OrgListRow[] }) {
  const t = useTranslations('admin.entities');
  const format = useFormatter();
  const { rows, sort, toggle } = useSortableRows<OrgListRow, Key>(source, ACCESSORS, { key: 'name', direction: 'asc' });

  if (source.length === 0) return <p className="text-ink-soft">{t('none')}</p>;
  return (
    <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label={t('region')} data-testid="org-list">
      <table className="w-full min-w-[40rem] border-collapse text-start">
        <caption className="sr-only">{t('caption')}</caption>
        <thead>
          <tr className="border-b-2 border-varsity-navy/20">
            <SortableTh label={t('col.name')} sortKey="name" sort={sort} onToggle={toggle} />
            <SortableTh label={t('col.province')} sortKey="province" sort={sort} onToggle={toggle} />
            <SortableTh label={t('col.kyb')} sortKey="kyb" sort={sort} onToggle={toggle} />
            <SortableTh label={t('col.submitted')} sortKey="submitted" sort={sort} onToggle={toggle} />
            <SortableTh label={t('col.medal')} sortKey="medal" sort={sort} onToggle={toggle} />
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
                {row.archived ? <span className="ms-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-bold">{t('archived')}</span> : null}
              </th>
              <td className="px-2 py-2">{row.province}</td>
              <td className="px-2 py-2 font-semibold">{t(`kyb.${row.kybStatus}`)}</td>
              <td className="px-2 py-2">{row.kybSubmittedAt ? format.dateTime(new Date(row.kybSubmittedAt), DATE) : t('noValue')}</td>
              <td className="px-2 py-2">{t(`medal.${row.medalRank}`)}</td>
              <td className="px-2 py-2">
                <Link href={`/admin/entidades/${row.id}`} className="inline-flex min-h-11 items-center font-bold text-varsity-navy underline" data-testid="open-360">
                  {t('open360')}
                  <span className="sr-only">{` ${row.name}`}</span>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
