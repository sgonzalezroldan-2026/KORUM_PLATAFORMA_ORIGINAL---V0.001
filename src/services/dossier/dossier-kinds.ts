import type { DossierMovement } from '@/core/dossier/dossier-model';

/**
 * Cómo se cuentan los movimientos en el expediente de la entidad (Sprint 5.8b). Funciones puras, sin base de datos.
 */

/**
 * Cómo se llama un asiento en el expediente de la entidad. El Auto-Impulso es una aportación más de las que admite la campaña (Regla 02 §7): una donación
 * en una de presupuesto y una entrada en una taquilla o rifa, donde no hay donaciones y «una donación» solo podría ser de KORUM. Y cuando KORUM lo recupera
 * (el contra-asiento de una campaña que venció tras un contracargo), una devolución más: si saliera como «corrección de un cobro», delataría qué cobro fue
 * de KORUM, porque a una familia nunca se le devuelve así.
 */
export function entityKindOf(kind: string, reversedKind: string | null, format: string): string {
  if (kind === 'SELF_BOOST_INJECTION') return format === 'TICKETING' ? 'PAYIN_TICKET' : 'PAYIN_DONATION';
  if (kind === 'REVERSAL' && reversedKind === 'SELF_BOOST_INJECTION') return 'ESCROW_REFUND_DONOR';
  // Lo que la bolsa Matching deja de añadir al devolverse una donación emparejada va aparte de las demás correcciones, y como ella, sin recuento.
  if (kind === 'REVERSAL' && reversedKind === 'MATCHING_RELEASE') return MATCHING_UNDONE;
  return kind;
}

/** Nombre, solo del expediente de la entidad, de la anulación de lo que añadió la bolsa Matching 2x (en el libro es un contra-asiento). */
export const MATCHING_UNDONE = 'MATCHING_UNDONE';

/**
 * Movimientos que van **sin recuento y sin días**: la bolsa Matching 2x añade a cada donación emparejada su mismo importe, así que su número, restado del
 * de donaciones, diría cuántas quedaron sin emparejar (y si es una sola, su importe); y sus días, cruzados con los de otra fila de dos movimientos en dos
 * días distintos, dirían qué importe tuvo la aportación de cada día (auditoría de seguridad del sprint). Van al final de la lista, en un orden fijo: su
 * sitio tampoco dice cuándo fueron.
 */
const UNCOUNTED_KINDS: ReadonlySet<string> = new Set(['MATCHING_RELEASE', MATCHING_UNDONE]);

/** El tipo de aportación con el que cuenta el Auto-Impulso en el expediente de la entidad. */
export const entityContributionTypeOf = (type: string, format: string): string => (type === 'SELF_BOOST' ? (format === 'TICKETING' ? 'TICKET' : 'DONATION') : type);

const SPAIN_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Día de España (`AAAA-MM-DD`) de un instante: los movimientos de la entidad nunca llevan su hora. */
export const spainDayOf = (instant: Date): string => SPAIN_DAY.format(instant);

/**
 * Movimientos que no salen de la aportación de una persona (la aprobación de la liquidación, el dinero de un comercio): van por su día. Todo lo demás
 * (cobros, lo que añade la bolsa Matching 2x por cada donación, devoluciones, contracargos, envíos cobro a cobro) va en una sola fila para toda la campaña.
 */
const NOT_PERSONAL_KINDS: ReadonlySet<string> = new Set(['PAYOUT_APPROVAL', 'PAYIN_SPONSOR', 'CREDIT_POOL_TRANSFER', 'ACTIVITY_FUND_DEPOSIT', 'ACTIVITY_FUND_PAYOUT_APPROVAL', 'INVOICE_VAT']);

export interface EntityEntry {
  occurredAt: Date;
  /** Ya con el nombre que ve la entidad (`entityKindOf`). */
  kind: string;
  account: string;
  direction: 'DEBIT' | 'CREDIT';
  amountCents: number;
}

/**
 * Suma los apuntes de la entidad por tipo, cuenta y sentido. **Lo que sale de aportaciones de personas va en una sola fila para toda la campaña**, con
 * su primer y su último día, cuántos son y su total (lo de la bolsa Matching 2x, solo con su total: `UNCOUNTED_KINDS`). No se desglosa por días: lo intentamos (por día, y después juntando días hasta tres movimientos) y
 * las dos veces una resta entre filas dejaba una aportación sola con su importe —un día con una única donación; o las donaciones de dos días menos lo que
 * la bolsa Matching emparejó en otros dos, que repite sus importes—. Con una fila por tipo, cualquier resta da totales de la campaña, que la entidad ya
 * conoce por su panel. Los totales no cambian: la suma de las filas es la de los apuntes.
 */
export function groupEntityMovements(entries: readonly EntityEntry[]): DossierMovement[] {
  const rows = new Map<string, DossierMovement>();
  for (const entry of entries) {
    const day = spainDayOf(entry.occurredAt);
    const series = `${entry.kind}|${entry.account}|${entry.direction}`;
    const key = NOT_PERSONAL_KINDS.has(entry.kind) ? `${series}|${day}` : series;
    if (UNCOUNTED_KINDS.has(entry.kind)) {
      const row = rows.get(key) ?? { from: null, to: null, kind: entry.kind, account: entry.account, direction: entry.direction, count: null, totalCents: 0 };
      rows.set(key, { ...row, totalCents: row.totalCents + entry.amountCents });
      continue;
    }
    const row = rows.get(key) ?? { from: day, to: day, kind: entry.kind, account: entry.account, direction: entry.direction, count: 0, totalCents: 0 };
    rows.set(key, { ...row, from: row.from === null || day < row.from ? day : row.from, to: row.to === null || day > row.to ? day : row.to, count: (row.count ?? 0) + 1, totalCents: row.totalCents + entry.amountCents });
  }
  const byName = (a: DossierMovement, b: DossierMovement) => a.kind.localeCompare(b.kind) || a.account.localeCompare(b.account) || a.direction.localeCompare(b.direction);
  const all = [...rows.values()];
  const dated = all.filter((row) => row.from !== null && row.to !== null).sort((a, b) => a.from!.localeCompare(b.from!) || a.to!.localeCompare(b.to!) || byName(a, b));
  return [...dated, ...all.filter((row) => row.from === null || row.to === null).sort(byName)];
}
