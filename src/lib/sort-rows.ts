export type SortDirection = 'asc' | 'desc';

export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}

export type SortValue = string | number | null | undefined;
export type SortAccessors<T, K extends string> = Record<K, (row: T) => SortValue>;

/**
 * Ordena una copia de las filas por la columna indicada. Estable, con números como números, textos con
 * orden natural del idioma (`3ºB` antes que `10ºA`) y valores vacíos siempre al final.
 */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  accessors: SortAccessors<T, K>,
  sort: SortState<K> | undefined,
  locale = 'es'
): T[] {
  if (!sort) return [...rows];
  const access = accessors[sort.key];
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const sign = sort.direction === 'asc' ? 1 : -1;

  return rows
    .map((row, index) => ({ row, index, value: access(row) }))
    .sort((a, b) => {
      const aEmpty = a.value === null || a.value === undefined || a.value === '';
      const bEmpty = b.value === null || b.value === undefined || b.value === '';
      if (aEmpty || bEmpty) return aEmpty === bEmpty ? a.index - b.index : aEmpty ? 1 : -1;
      const comparison =
        typeof a.value === 'number' && typeof b.value === 'number' ? a.value - b.value : collator.compare(String(a.value), String(b.value));
      return comparison !== 0 ? comparison * sign : a.index - b.index;
    })
    .map((entry) => entry.row);
}

/**
 * Siguiente estado al pulsar una cabecera: la primera vez de mayor a menor, después se alterna (Regla 03 §9).
 */
export function nextSortState<K extends string>(current: SortState<K> | undefined, key: K): SortState<K> {
  if (current?.key !== key) return { key, direction: 'desc' };
  return { key, direction: current.direction === 'desc' ? 'asc' : 'desc' };
}
