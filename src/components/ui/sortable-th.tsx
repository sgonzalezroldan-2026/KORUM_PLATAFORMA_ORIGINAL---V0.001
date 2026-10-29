'use client';

import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import type { SortState } from '@/lib/sort-rows';

export interface SortableThProps<K extends string> {
  label: string;
  /** Nombre de la columna para lectores de pantalla cuando `label` lleva emojis o símbolos (p. ej. «💛 Aportaciones»). */
  columnName?: string;
  sortKey: K;
  sort: SortState<K> | undefined;
  onToggle: (key: K) => void;
  align?: 'start' | 'end';
  className?: string;
}

/** Cabecera de tabla ordenable: al pulsarla ordena de mayor a menor y, al volver a pulsar, al revés (`↕`). */
export function SortableTh<K extends string>({ label, columnName, sortKey, sort, onToggle, align = 'start', className }: SortableThProps<K>) {
  const t = useTranslations('ui.table');
  const active = sort?.key === sortKey;
  const ariaSort = active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';
  const indicator = active ? (sort.direction === 'asc' ? '▲' : '▼') : '↕';

  return (
    <th scope="col" aria-sort={ariaSort} className={clsx('px-2 py-1 font-corp text-sm font-bold', align === 'end' ? 'text-end' : 'text-start', className)}>
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        aria-label={t('sortBy', { column: columnName ?? label })}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-1 hover:bg-varsity-navy/5"
      >
        <span>{label}</span>
        <span aria-hidden="true" className={clsx('text-xs', active ? 'text-varsity-navy' : 'text-ink-soft')}>
          {indicator}
        </span>
      </button>
    </th>
  );
}
