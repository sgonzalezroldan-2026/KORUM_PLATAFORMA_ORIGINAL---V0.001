/**
 * Cuadro de mandos de la entidad (Sprint 4.1, `renderSchoolDashboard` del prototipo): filtros, indicadores y la línea de 6 estados.
 * Funciones puras y deterministas sobre lo que la entidad ya ha leído con su guardia; no tocan la base de datos.
 */

export type DashboardStatus = 'BUDGETING' | 'FUNDRAISING' | 'GOAL_REACHED' | 'CLOSED' | 'EXPIRED' | 'RESIZE_VOTING' | 'REFUNDING' | 'REFUNDED' | 'CANCELLED';

export const DASHBOARD_STATUSES: readonly DashboardStatus[] = ['BUDGETING', 'FUNDRAISING', 'GOAL_REACHED', 'CLOSED', 'EXPIRED', 'RESIZE_VOTING', 'REFUNDING', 'REFUNDED', 'CANCELLED'];

/** Las 6 fases de una iniciativa (`Initiative.stepIndex`, de 0 a 5). Los textos viven en `panel.dashboard.steps.*`. */
export const TIMELINE_STEPS = ['moderation', 'signatures', 'doubleCheck', 'budget', 'fundraising', 'achievement'] as const;
export type TimelineStep = (typeof TIMELINE_STEPS)[number];

export interface DashboardInitiative {
  id: number;
  walletEscrowId: string;
  title: string;
  category: string;
  academicYear: string;
  format: 'BUDGET' | 'TICKETING';
  status: DashboardStatus;
  stepIndex: number;
  raisedCents: number;
  goalCents: number;
  /** Fecha de cierre en ISO 8601. */
  closesAt: string;
  totalContributions: number;
}

export interface DashboardFilters {
  /** Curso `AAAA-AAAA` o `ALL`. */
  year: string;
  /** Categoría o `ALL`. */
  category: string;
  status: DashboardStatus | 'ALL';
}

export const NO_FILTERS: DashboardFilters = { year: 'ALL', category: 'ALL', status: 'ALL' };

export function filterInitiatives(items: readonly DashboardInitiative[], filters: DashboardFilters): DashboardInitiative[] {
  return items.filter(
    (item) =>
      (filters.year === 'ALL' || item.academicYear === filters.year) &&
      (filters.category === 'ALL' || item.category === filters.category) &&
      (filters.status === 'ALL' || item.status === filters.status)
  );
}

/** Cuántos de los tres filtros están activos: es el número que se pinta junto a «Filtrar». */
export function activeFilterCount(filters: DashboardFilters): number {
  return [filters.year !== 'ALL', filters.category !== 'ALL', filters.status !== 'ALL'].filter(Boolean).length;
}

/** Cursos y categorías que existen en los datos, para los desplegables. Los cursos van del más reciente al más antiguo. */
export function filterOptions(items: readonly DashboardInitiative[]): { years: string[]; categories: string[] } {
  const years = [...new Set(items.map((item) => item.academicYear))].sort((a, b) => b.localeCompare(a));
  const categories = [...new Set(items.map((item) => item.category))].sort((a, b) => a.localeCompare(b, 'es'));
  return { years, categories };
}

export interface DashboardKpis {
  total: number;
  active: number;
  achieved: number;
  raisedCents: number;
}

/** Estados en los que lo recaudado ya se devolvió o nunca se cobró: no suman al «Recaudado». */
const NOT_RAISED: ReadonlySet<DashboardStatus> = new Set(['REFUNDING', 'REFUNDED', 'CANCELLED']);

export function computeKpis(items: readonly DashboardInitiative[]): DashboardKpis {
  return {
    total: items.length,
    active: items.filter((item) => item.status === 'FUNDRAISING').length,
    achieved: items.filter((item) => item.status === 'GOAL_REACHED' || item.status === 'CLOSED').length,
    raisedCents: items.filter((item) => !NOT_RAISED.has(item.status)).reduce((sum, item) => sum + item.raisedCents, 0)
  };
}

export type StepState = 'done' | 'current' | 'pending';

/** Estado de cada una de las 6 fases según el paso de la iniciativa. Un paso fuera de rango se acota. */
export function timelineStates(stepIndex: number): StepState[] {
  const current = Math.min(Math.max(Math.trunc(stepIndex), 0), TIMELINE_STEPS.length - 1);
  return TIMELINE_STEPS.map((_, index) => (index < current ? 'done' : index === current ? 'current' : 'pending'));
}

/** Porcentaje entero de avance, acotado a 0–100 (la barra no se desborda si se recauda más que la meta). */
export function progressPercent(raisedCents: number, goalCents: number): number {
  if (goalCents <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((raisedCents * 100) / goalCents)));
}

/** Las iniciativas con ficha pública (`/{orgSlug}/iniciativas/{id}`): las mismas que el portal de las familias deja ver. */
export function hasPublicPage(status: DashboardStatus): boolean {
  return status === 'FUNDRAISING' || status === 'GOAL_REACHED' || status === 'CLOSED';
}

export type FirstCampaignStepKey = 'signers' | 'documents' | 'studio';
export interface FirstCampaignStep {
  key: FirstCampaignStepKey;
  done: boolean;
}

/**
 * Pasos del estado vacío guiado: lo que falta antes de publicar la primera campaña. Las dos firmas listas, los documentos del titular
 * verificados y, por último, crear la campaña en el Estudio (siempre pendiente mientras no haya ninguna iniciativa).
 */
export function firstCampaignSteps(input: { readySigners: number; kybStatus: string }): FirstCampaignStep[] {
  return [
    { key: 'signers', done: input.readySigners >= 2 },
    { key: 'documents', done: input.kybStatus === 'VERIFIED' },
    { key: 'studio', done: false }
  ];
}
