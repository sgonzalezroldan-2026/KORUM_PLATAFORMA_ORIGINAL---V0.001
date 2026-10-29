'use client';

import { useLocale } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';
import { nextSortState, sortRows, type SortAccessors, type SortState } from './sort-rows';

/** Estado de ordenación de una tabla: `rows` ya ordenadas, `sort` actual y `toggle(key)` para las cabeceras. */
export function useSortableRows<T, K extends string>(rows: readonly T[], accessors: SortAccessors<T, K>, initial?: SortState<K>) {
  const locale = useLocale();
  const [sort, setSort] = useState<SortState<K> | undefined>(initial);

  const sorted = useMemo(() => sortRows(rows, accessors, sort, locale), [rows, accessors, sort, locale]);
  const toggle = useCallback((key: K) => setSort((current) => nextSortState(current, key)), []);

  return { rows: sorted, sort, toggle };
}
