/**
 * Lógica pura del portal público de familias (Entorno 1): progreso, días restantes, filtros ocultos del listado y orden. Sin base de datos ni
 * React, para poder probarla con casos límite. Todos los importes son céntimos enteros (Regla 01 §2).
 */

export type PublicFormat = 'BUDGET' | 'TICKETING';
/** Modos de Mi Hucha que se dibujan en el portal; `DISABLED` la oculta. */
export type VisibleHuchaMode = 'PLEDGE' | 'REGULATED_WALLET';
export type UrgencyFilter = 'ALL' | 'SOON' | 'ALMOST' | 'TICKETING';

/** Recta final: a partir de este porcentaje (entero) de la meta. */
export const ALMOST_THERE_PERCENT = 75;
/** Cierre cercano: quedan menos de estos días (el prototipo usa «<20 días»). */
export const CLOSING_SOON_DAYS = 20;
const DAY_MS = 86_400_000;

export interface CatalogEntry {
  id: number;
  format: PublicFormat;
  title: string;
  category: string;
  stage: string;
  raisedCents: number;
  goalCents: number;
  ticketsSold: number;
  ticketMax: number;
  ticketsHeld: number;
  closesAt: Date;
  matchingPoolRemainingCents: number;
}

/** Entero de 0 a 100. Solo llega a 100 cuando se ha alcanzado de verdad: un 99,6 % nunca se muestra como «100 %». */
export function percentOf(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done <= 0) return 0;
  if (done >= total) return 100;
  return Math.min(99, Math.floor((done * 100) / total));
}

export function progressPercent(entry: Pick<CatalogEntry, 'format' | 'raisedCents' | 'goalCents' | 'ticketsSold' | 'ticketMax'>): number {
  return entry.format === 'TICKETING' ? percentOf(entry.ticketsSold, entry.ticketMax) : percentOf(entry.raisedCents, entry.goalCents);
}

/** Plazas que aún se pueden comprar: lo vendido y lo retenido por pagos en curso no cuentan como libres. */
export function ticketsAvailable(entry: Pick<CatalogEntry, 'ticketsSold' | 'ticketMax' | 'ticketsHeld'>): number {
  return Math.max(0, entry.ticketMax - entry.ticketsSold - entry.ticketsHeld);
}

/** Días completos que quedan hasta el cierre (se redondea hacia arriba: «quedan 1 día» hasta el último segundo). Nunca negativo. */
export function daysLeft(closesAt: Date, now: Date): number {
  const remaining = closesAt.getTime() - now.getTime();
  return remaining <= 0 ? 0 : Math.ceil(remaining / DAY_MS);
}

export function isAchieved(entry: Pick<CatalogEntry, 'format' | 'raisedCents' | 'goalCents' | 'ticketsSold' | 'ticketMax' | 'ticketsHeld'>): boolean {
  if (entry.format === 'TICKETING') return entry.ticketMax > 0 && ticketsAvailable(entry) === 0;
  return entry.goalCents > 0 && entry.raisedCents >= entry.goalCents;
}

export interface CatalogFilters {
  /** `''` = todas. */
  category: string;
  urgency: UrgencyFilter;
  /** `''` = todas. */
  stage: string;
}

export const NO_FILTERS: CatalogFilters = { category: '', urgency: 'ALL', stage: '' };

export function countActiveFilters(filters: CatalogFilters): number {
  return [filters.category !== '', filters.urgency !== 'ALL', filters.stage !== ''].filter(Boolean).length;
}

export interface CardView {
  id: number;
  format: PublicFormat;
  category: string;
  stage: string;
  pct: number;
  daysLeft: number;
}

export function matchesFilters(card: CardView, filters: CatalogFilters): boolean {
  if (filters.category !== '' && card.category !== filters.category) return false;
  if (filters.stage !== '' && card.stage !== filters.stage) return false;
  if (filters.urgency === 'SOON' && card.daysLeft >= CLOSING_SOON_DAYS) return false;
  if (filters.urgency === 'ALMOST' && card.pct < ALMOST_THERE_PERCENT) return false;
  if (filters.urgency === 'TICKETING' && card.format !== 'TICKETING') return false;
  return true;
}

/** Opciones de los desplegables: solo lo que existe en las campañas abiertas, sin repetidos y en orden alfabético estable. */
export function distinctOptions(values: readonly string[], locale: string): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ''))].sort((a, b) => a.localeCompare(b, locale));
}

/** Las que tienen *Matching 2x* activo van primero (destacadas); dentro de cada grupo, la que cierra antes y, a igualdad, el identificador. */
export function compareForCatalog(a: Pick<CatalogEntry, 'id' | 'closesAt' | 'matchingPoolRemainingCents'>, b: Pick<CatalogEntry, 'id' | 'closesAt' | 'matchingPoolRemainingCents'>): number {
  const matchingA = a.matchingPoolRemainingCents > 0 ? 0 : 1;
  const matchingB = b.matchingPoolRemainingCents > 0 ? 0 : 1;
  if (matchingA !== matchingB) return matchingA - matchingB;
  const closing = a.closesAt.getTime() - b.closesAt.getTime();
  return closing !== 0 ? closing : a.id - b.id;
}
