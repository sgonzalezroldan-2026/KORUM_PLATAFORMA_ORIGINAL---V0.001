import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SortableTh } from '@/components/ui/sortable-th';
import { nextSortState, sortRows, type SortState } from '@/lib/sort-rows';
import { useSortableRows } from '@/lib/use-sortable-rows';
import { renderWithIntl } from '../utils/render-with-intl';

interface Row {
  name: string;
  contributions: number | null;
}

const ROWS: Row[] = [
  { name: '10ºA', contributions: 5 },
  { name: '3ºB', contributions: 28 },
  { name: 'Alevín', contributions: null },
  { name: '2ºC', contributions: 28 }
];
const ACCESSORS = { name: (row: Row) => row.name, contributions: (row: Row) => row.contributions };

describe('sortRows', () => {
  it('ordena números de mayor a menor y deja los vacíos al final', () => {
    const sorted = sortRows(ROWS, ACCESSORS, { key: 'contributions', direction: 'desc' });
    expect(sorted.map((row) => row.name)).toEqual(['3ºB', '2ºC', '10ºA', 'Alevín']);
  });

  it('en ascendente los vacíos siguen al final', () => {
    const sorted = sortRows(ROWS, ACCESSORS, { key: 'contributions', direction: 'asc' });
    expect(sorted.map((row) => row.name)).toEqual(['10ºA', '3ºB', '2ºC', 'Alevín']);
  });

  it('es estable: los empates conservan el orden original', () => {
    const desc = sortRows(ROWS, ACCESSORS, { key: 'contributions', direction: 'desc' });
    expect(desc.slice(0, 2).map((row) => row.name)).toEqual(['3ºB', '2ºC']);
  });

  it('usa el orden natural del texto (3ºB antes que 10ºA)', () => {
    const sorted = sortRows(ROWS, ACCESSORS, { key: 'name', direction: 'asc' });
    expect(sorted.map((row) => row.name)).toEqual(['2ºC', '3ºB', '10ºA', 'Alevín']);
  });

  it('no modifica la lista original', () => {
    const copy = [...ROWS];
    sortRows(ROWS, ACCESSORS, { key: 'name', direction: 'desc' });
    expect(ROWS).toEqual(copy);
  });

  it('sin ordenación devuelve una copia en el orden original', () => {
    const result = sortRows(ROWS, ACCESSORS, undefined);
    expect(result).toEqual(ROWS);
    expect(result).not.toBe(ROWS);
  });
});

describe('nextSortState · Regla 03 §9', () => {
  it('la primera pulsación ordena de mayor a menor y las siguientes alternan', () => {
    let state: SortState<'a' | 'b'> | undefined;
    state = nextSortState(state, 'a');
    expect(state).toEqual({ key: 'a', direction: 'desc' });
    state = nextSortState(state, 'a');
    expect(state).toEqual({ key: 'a', direction: 'asc' });
    state = nextSortState(state, 'a');
    expect(state).toEqual({ key: 'a', direction: 'desc' });
  });

  it('cambiar de columna vuelve a empezar de mayor a menor', () => {
    expect(nextSortState({ key: 'a', direction: 'asc' }, 'b')).toEqual({ key: 'b', direction: 'desc' });
  });
});

function Table() {
  const { rows, sort, toggle } = useSortableRows(ROWS, ACCESSORS);
  return (
    <table>
      <thead>
        <tr>
          <SortableTh label="Curso" sortKey="name" sort={sort} onToggle={toggle} />
          <SortableTh label="Aportaciones" sortKey="contributions" sort={sort} onToggle={toggle} align="end" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name}>
            <td>{row.name}</td>
            <td>{row.contributions ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function firstColumn(): string[] {
  const body = screen.getAllByRole('rowgroup')[1]!;
  return within(body)
    .getAllByRole('row')
    .map((row) => within(row).getAllByRole('cell')[0]!.textContent ?? '');
}

describe('SortableTh + useSortableRows', () => {
  it('ordena al pulsar la cabecera y anuncia el sentido con aria-sort', () => {
    renderWithIntl(<Table />);
    const header = screen.getByRole('columnheader', { name: /Aportaciones/ });
    expect(header).toHaveAttribute('aria-sort', 'none');

    fireEvent.click(screen.getByRole('button', { name: 'Ordenar por Aportaciones' }));
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(firstColumn()).toEqual(['3ºB', '2ºC', '10ºA', 'Alevín']);

    fireEvent.click(screen.getByRole('button', { name: 'Ordenar por Aportaciones' }));
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(firstColumn()).toEqual(['10ºA', '3ºB', '2ºC', 'Alevín']);
  });

  it('solo una columna queda activa a la vez', () => {
    renderWithIntl(<Table />);
    fireEvent.click(screen.getByRole('button', { name: 'Ordenar por Aportaciones' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ordenar por Curso' }));
    expect(screen.getByRole('columnheader', { name: /Aportaciones/ })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: /Curso/ })).toHaveAttribute('aria-sort', 'descending');
  });

  it('el nombre accesible del botón contiene el texto visible y sale en el idioma activo', () => {
    renderWithIntl(<Table />, 'ca');
    expect(screen.getByRole('button', { name: 'Ordenar per Curso' })).toBeInTheDocument();
  });
});
