import { describe, expect, it, vi } from 'vitest';
import {
  ALMOST_THERE_PERCENT,
  CLOSING_SOON_DAYS,
  compareForCatalog,
  countActiveFilters,
  daysLeft,
  distinctOptions,
  isAchieved,
  matchesFilters,
  NO_FILTERS,
  percentOf,
  progressPercent,
  ticketsAvailable,
  type CardView
} from '@/core/public/catalog';
import { buildCourseChallenge, defaultGroupTemplate, findGroupBySlug, groupSlug, orderedGroupNames } from '@/core/public/course-challenge';
import { buildBreakdown, buildTicketInfo, localizeRow, toCardData, toDetailData, type InitiativeRow } from '@/core/public/view-model';
import { OFFICIAL_SCHOOL_13_COURSES } from '@/types/korum.types';

vi.mock('@/lib/error-reporting', () => ({ reportError: vi.fn() }));

const NOW = new Date('2026-11-06T10:00:00Z');
const DAY = 86_400_000;

function row(overrides: Partial<InitiativeRow> = {}): InitiativeRow {
  return {
    id: 1,
    status: 'FUNDRAISING',
    walletEscrowId: 'WLT-ESC-001',
    format: 'BUDGET',
    title: 'Ventiladores para las aulas',
    category: 'Infraestructura',
    stage: 'Primaria',
    description: 'Ventiladores de techo para 12 aulas.',
    closesAt: new Date(NOW.getTime() + 10 * DAY),
    raisedCents: 150_000,
    goalCents: 400_000,
    totalContributions: 12,
    showPublicBreakdown: true,
    matchingPoolRemainingCents: 0,
    matchingSponsorName: null,
    ticketSubtype: null,
    ticketPriceCents: null,
    ticketMax: null,
    ticketsSold: 0,
    ticketsHeld: 0,
    ticketFeeMode: null,
    ticketVenue: null,
    plaqueEnabled: true,
    rewardEnabled: true,
    rewardText: 'Tarde de cine',
    targetFamiliesPerCourse: 35,
    costMatCents: 300_000,
    costInstCents: 50_000,
    contingencyBps: 1000,
    bracketFeeCents: 4_000,
    maintFeeCents: 0,
    quotaReservedAt: new Date('2026-10-01T10:00:00Z'),
    courses: [],
    ...overrides
  };
}

describe('QA-F01 · avance y días restantes', () => {
  it('el porcentaje solo llega a 100 cuando la meta se ha alcanzado de verdad', () => {
    expect(percentOf(0, 100)).toBe(0);
    expect(percentOf(996, 1000)).toBe(99);
    expect(percentOf(999_999, 1_000_000)).toBe(99);
    expect(percentOf(1000, 1000)).toBe(100);
    expect(percentOf(1500, 1000)).toBe(100);
  });

  it('no se rompe con metas imposibles, negativos ni valores que no son números', () => {
    for (const [done, total] of [[5, 0], [5, -1], [-5, 100], [Number.NaN, 100], [100, Number.NaN], [Number.POSITIVE_INFINITY, 100]] as const) {
      expect(percentOf(done, total)).toBeGreaterThanOrEqual(0);
      expect(percentOf(done, total)).toBeLessThanOrEqual(100);
    }
    expect(percentOf(5, 0)).toBe(0);
  });

  it('en taquilla el avance son las entradas vendidas, no el dinero', () => {
    expect(progressPercent({ format: 'TICKETING', raisedCents: 0, goalCents: 0, ticketsSold: 30, ticketMax: 120 })).toBe(25);
    expect(progressPercent({ format: 'BUDGET', raisedCents: 150_000, goalCents: 400_000, ticketsSold: 0, ticketMax: 0 })).toBe(37);
  });

  it('las plazas libres descuentan lo retenido por pagos en curso y nunca bajan de 0', () => {
    expect(ticketsAvailable({ ticketsSold: 90, ticketsHeld: 5, ticketMax: 100 })).toBe(5);
    expect(ticketsAvailable({ ticketsSold: 100, ticketsHeld: 3, ticketMax: 100 })).toBe(0);
  });

  it('un aforo con todo vendido o retenido figura como completo; una campaña, al llegar a la meta', () => {
    expect(isAchieved({ format: 'TICKETING', raisedCents: 0, goalCents: 0, ticketsSold: 98, ticketsHeld: 2, ticketMax: 100 })).toBe(true);
    expect(isAchieved({ format: 'TICKETING', raisedCents: 0, goalCents: 0, ticketsSold: 10, ticketsHeld: 0, ticketMax: 100 })).toBe(false);
    expect(isAchieved({ format: 'TICKETING', raisedCents: 0, goalCents: 0, ticketsSold: 0, ticketsHeld: 0, ticketMax: 0 })).toBe(false);
    expect(isAchieved({ format: 'BUDGET', raisedCents: 400_000, goalCents: 400_000, ticketsSold: 0, ticketsHeld: 0, ticketMax: 0 })).toBe(true);
    expect(isAchieved({ format: 'BUDGET', raisedCents: 399_999, goalCents: 400_000, ticketsSold: 0, ticketsHeld: 0, ticketMax: 0 })).toBe(false);
  });

  it('los días restantes se redondean hacia arriba y nunca son negativos', () => {
    expect(daysLeft(new Date(NOW.getTime() + 1), NOW)).toBe(1);
    expect(daysLeft(new Date(NOW.getTime() + DAY), NOW)).toBe(1);
    expect(daysLeft(new Date(NOW.getTime() + DAY + 1), NOW)).toBe(2);
    expect(daysLeft(NOW, NOW)).toBe(0);
    expect(daysLeft(new Date(NOW.getTime() - 5 * DAY), NOW)).toBe(0);
  });
});

describe('QA-F01 · filtros ocultos del listado', () => {
  const card = (overrides: Partial<CardView> = {}): CardView => ({ id: 1, format: 'BUDGET', category: 'Patios', stage: 'Primaria', pct: 40, daysLeft: 30, ...overrides });

  it('sin filtros pasan todas y el contador es 0', () => {
    expect(matchesFilters(card(), NO_FILTERS)).toBe(true);
    expect(countActiveFilters(NO_FILTERS)).toBe(0);
  });

  it('cuenta cada filtro activo, también la urgencia', () => {
    expect(countActiveFilters({ category: 'Patios', urgency: 'ALL', stage: '' })).toBe(1);
    expect(countActiveFilters({ category: 'Patios', urgency: 'SOON', stage: 'ESO' })).toBe(3);
  });

  it('cierre cercano: menos de 20 días (el día 20 ya no cuenta); recta final: 75 % o más', () => {
    expect(matchesFilters(card({ daysLeft: CLOSING_SOON_DAYS - 1 }), { ...NO_FILTERS, urgency: 'SOON' })).toBe(true);
    expect(matchesFilters(card({ daysLeft: CLOSING_SOON_DAYS }), { ...NO_FILTERS, urgency: 'SOON' })).toBe(false);
    expect(matchesFilters(card({ pct: ALMOST_THERE_PERCENT }), { ...NO_FILTERS, urgency: 'ALMOST' })).toBe(true);
    expect(matchesFilters(card({ pct: ALMOST_THERE_PERCENT - 1 }), { ...NO_FILTERS, urgency: 'ALMOST' })).toBe(false);
  });

  it('solo taquilla y rifas deja fuera las campañas', () => {
    expect(matchesFilters(card({ format: 'TICKETING' }), { ...NO_FILTERS, urgency: 'TICKETING' })).toBe(true);
    expect(matchesFilters(card({ format: 'BUDGET' }), { ...NO_FILTERS, urgency: 'TICKETING' })).toBe(false);
  });

  it('categoría y etapa exigen coincidencia exacta y se combinan', () => {
    const filters = { category: 'Patios', urgency: 'ALL' as const, stage: 'ESO' };
    expect(matchesFilters(card({ stage: 'ESO' }), filters)).toBe(true);
    expect(matchesFilters(card({ stage: 'Primaria' }), filters)).toBe(false);
    expect(matchesFilters(card({ category: 'Tecnología', stage: 'ESO' }), filters)).toBe(false);
  });

  it('los desplegables ofrecen solo valores presentes, sin repetidos ni vacíos y ordenados', () => {
    expect(distinctOptions(['Primaria', ' ESO ', 'Primaria', '', 'Infantil'], 'es')).toEqual(['ESO', 'Infantil', 'Primaria']);
  });

  it('las campañas con Matching 2x van primero; después, la que cierra antes y, a igualdad, el identificador', () => {
    const entries = [
      { id: 3, closesAt: new Date(NOW.getTime() + 2 * DAY), matchingPoolRemainingCents: 0 },
      { id: 2, closesAt: new Date(NOW.getTime() + 9 * DAY), matchingPoolRemainingCents: 5_000 },
      { id: 4, closesAt: new Date(NOW.getTime() + 2 * DAY), matchingPoolRemainingCents: 0 },
      { id: 1, closesAt: new Date(NOW.getTime() + 30 * DAY), matchingPoolRemainingCents: 100 }
    ];
    expect([...entries].sort(compareForCatalog).map((entry) => entry.id)).toEqual([2, 1, 3, 4]);
  });
});

describe('Regla 03 §6 · reto por curso solo en positivo', () => {
  const names = orderedGroupNames('SCHOOL', null);

  it('el identificador del grupo para la URL es estable y sin acentos ni la palabra «de»', () => {
    expect(groupSlug('3º de Primaria')).toBe('3-primaria');
    expect(groupSlug('Sénior / Primer Equipo')).toBe('senior-primer-equipo');
    expect(groupSlug('Infantil 3 años (I3)')).toBe('infantil-3-anos-i3');
    expect(groupSlug('Vecino / Amigo del Barrio')).toBe('vecino-amigo-del-barrio');
    expect(groupSlug('  ¡¡¡  ')).toBe('');
  });

  it('todos los grupos de las tres plantillas tienen un identificador único', () => {
    for (const vertical of ['SCHOOL', 'SPORTS_CLUB', 'CULTURAL']) {
      const slugs = orderedGroupNames(vertical, null).map(groupSlug);
      expect(new Set(slugs).size).toBe(slugs.length);
      expect(slugs.every((slug) => /^[a-z0-9-]+$/.test(slug) && slug.length > 0)).toBe(true);
    }
  });

  it('el orden es el de la plantilla (13 cursos + 2 de comunidad), no el avance', () => {
    expect(names).toHaveLength(15);
    const lines = buildCourseChallenge(
      [
        { groupName: '3º de Primaria', familiesCount: 34 },
        { groupName: '1º de Primaria', familiesCount: 2 },
        { groupName: 'Infantil 3 años (I3)', familiesCount: 20 }
      ],
      35,
      names
    );
    expect(lines.map((line) => line.groupName)).toEqual(['Infantil 3 años (I3)', '1º de Primaria', '3º de Primaria']);
  });

  it('no enseña los grupos que aún no suman familias y calcula lo que falta', () => {
    const lines = buildCourseChallenge([{ groupName: '3º de Primaria', familiesCount: 28 }, { groupName: '4º de Primaria', familiesCount: 0 }], 35, names);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ groupName: '3º de Primaria', familiesCount: 28, target: 35, missing: 7, reached: false, pct: 80, slug: '3-primaria' });
  });

  it('un grupo que llega al reto lo celebra y el 100 % solo se muestra si de verdad lo logró', () => {
    const [reached, almost] = buildCourseChallenge([{ groupName: '1º de ESO', familiesCount: 40 }, { groupName: '2º de ESO', familiesCount: 34 }], 35, names);
    expect(reached).toMatchObject({ reached: true, missing: 0, pct: 100 });
    expect(almost).toMatchObject({ reached: false, missing: 1, pct: 97 });
  });

  it('un objetivo inválido no divide por cero', () => {
    for (const target of [0, -3, Number.NaN, 1.5]) {
      const [line] = buildCourseChallenge([{ groupName: '1º de ESO', familiesCount: 2 }], target, names);
      expect(Number.isFinite(line?.pct)).toBe(true);
      expect(line?.target).toBeGreaterThan(0);
    }
  });

  it('los grupos desconocidos van al final por orden alfabético', () => {
    const lines = buildCourseChallenge([{ groupName: 'Zeta', familiesCount: 1 }, { groupName: 'Alfa', familiesCount: 1 }, { groupName: '1º de ESO', familiesCount: 1 }], 35, names);
    expect(lines.map((line) => line.groupName)).toEqual(['1º de ESO', 'Alfa', 'Zeta']);
  });

  it('usa los grupos de la entidad si los personalizó y la plantilla del vertical si el dato no es válido', () => {
    expect(orderedGroupNames('SCHOOL', [{ group: 'Mis grupos', items: ['Rojos', 'Azules'] }])).toEqual(['Rojos', 'Azules']);
    for (const invalid of [null, undefined, 'x', 42, [{ group: 1 }], [{ group: 'vacío', items: [] }]]) {
      expect(orderedGroupNames('SPORTS_CLUB', invalid)).toEqual(defaultGroupTemplate('SPORTS_CLUB').flatMap((cluster) => cluster.items));
    }
    expect(orderedGroupNames('SCHOOL', null)).toEqual(OFFICIAL_SCHOOL_13_COURSES.flatMap((cluster) => cluster.items));
  });

  it('?grupo= solo elige un grupo conocido; el texto de la URL nunca se devuelve', () => {
    const rows = [{ groupName: '3º de Primaria', familiesCount: 5 }];
    expect(findGroupBySlug(rows, '3-primaria')).toEqual(rows[0]);
    expect(findGroupBySlug(rows, '<script>alert(1)</script>')).toBeNull();
    expect(findGroupBySlug(rows, '')).toBeNull();
    expect(findGroupBySlug(rows, null)).toBeNull();
    expect(findGroupBySlug(rows, undefined)).toBeNull();
  });
});

describe('QA-F03 · las 4 líneas públicas suman exactamente la meta', () => {
  it('línea 1 + 2 + 3 + 4 === meta, con importes de todo tipo', () => {
    let seed = 20_261_106;
    const next = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    for (let i = 0; i < 1000; i += 1) {
      const costMatCents = next(2_000_000);
      const costInstCents = next(500_000);
      const contingencyBps = next(3000);
      const execution = costMatCents + costInstCents;
      const goalCents = Math.ceil((execution + Math.round((execution * contingencyBps) / 10000) + next(30_000)) / 100) * 100;
      const breakdown = buildBreakdown(row({ costMatCents, costInstCents, contingencyBps, goalCents }));
      if (breakdown.kind !== 'shown') continue;
      const lines = breakdown.data;
      expect(lines.providerCents + lines.installCents + lines.contingencyCents + lines.escrowAndGuaranteeCents).toBe(goalCents);
      expect(lines.escrowAndGuaranteeCents).toBeGreaterThanOrEqual(0);
    }
  });

  it('con la pizarra de la semilla (3.000 + 500 + 10 %) la cuarta línea es lo que falta hasta la meta', () => {
    const breakdown = buildBreakdown(row({ costMatCents: 300_000, costInstCents: 50_000, contingencyBps: 1000, goalCents: 400_000 }));
    expect(breakdown.kind === 'shown' ? breakdown.data : null).toMatchObject({ providerCents: 300_000, installCents: 50_000, contingencyCents: 35_000, escrowAndGuaranteeCents: 15_000, realExecutionCents: 385_000, totalGoalCents: 400_000 });
  });

  it('si la entidad decide no enseñar el desglose no se publica, pero el presupuesto sigue comprobado; una taquilla no tiene desglose', () => {
    expect(buildBreakdown(row({ showPublicBreakdown: false }))).toEqual({ kind: 'hidden' });
    expect(buildBreakdown(row({ format: 'TICKETING' }))).toEqual({ kind: 'none' });
  });

  it('un coste real mayor que la meta no puede cuadrar: no se publica un desglose falso ni se dice que el presupuesto está «validado»', () => {
    const over = { costMatCents: 500_000, costInstCents: 0, contingencyBps: 1000, goalCents: 400_000 };
    expect(buildBreakdown(row(over))).toEqual({ kind: 'mismatch' });
    // Aunque la entidad oculte las líneas, el descuadre se detecta: el aviso «validado» solo sale si el coste cabe en la meta.
    expect(buildBreakdown(row({ ...over, showPublicBreakdown: false }))).toEqual({ kind: 'mismatch' });
  });
});

describe('Taquilla · gastos de gestión digital', () => {
  const fees = { ticketFeeFixedCents: 45, ticketFeeBps: 200 };

  it('ADD: el precio llega íntegro a la entidad y la gestión se suma encima', () => {
    expect(buildTicketInfo(row({ format: 'TICKETING', ticketPriceCents: 500, ticketFeeMode: 'ADD' }), fees)).toMatchObject({ mode: 'ADD', priceCents: 500, feeUnitCents: 55, buyerUnitCents: 555, centerUnitCents: 500 });
  });

  it('INC: la gestión va dentro del precio y la entidad recibe el resto', () => {
    expect(buildTicketInfo(row({ format: 'TICKETING', ticketPriceCents: 500, ticketFeeMode: 'INC' }), fees)).toMatchObject({ mode: 'INC', feeUnitCents: 55, buyerUnitCents: 500, centerUnitCents: 445 });
  });

  it('INC: la gestión nunca supera el precio', () => {
    const info = buildTicketInfo(row({ format: 'TICKETING', ticketPriceCents: 30, ticketFeeMode: 'INC' }), fees);
    expect(info?.feeUnitCents).toBe(30);
    expect(info?.centerUnitCents).toBe(0);
  });

  it('una campaña de donaciones o una taquilla sin precio no tienen información de taquilla', () => {
    expect(buildTicketInfo(row(), fees)).toBeNull();
    expect(buildTicketInfo(row({ format: 'TICKETING', ticketPriceCents: null, ticketFeeMode: 'ADD' }), fees)).toBeNull();
  });
});

describe('QA-F02 · datos de la tarjeta', () => {
  it('lleva las aportaciones, los días y el Matching 2x, y es serializable', () => {
    const card = toCardData(row({ matchingPoolRemainingCents: 10_000 }), NOW);
    expect(card).toMatchObject({ contributions: 12, daysLeft: 10, pct: 37, matching: true, achieved: false, closed: false });
    expect(JSON.parse(JSON.stringify(card))).toEqual(card);
  });

  it('con la bolsa de Matching agotada ya no se destaca', () => {
    expect(toCardData(row({ matchingPoolRemainingCents: 0 }), NOW).matching).toBe(false);
  });

  it('«0 % de comisión» solo cuando la iniciativa de donaciones no paga comisión de tramos', () => {
    expect(toCardData(row({ bracketFeeCents: 0 }), NOW).zeroCommission).toBe(true);
    expect(toCardData(row({ bracketFeeCents: 4_000 }), NOW).zeroCommission).toBe(false);
    expect(toCardData(row({ format: 'TICKETING', bracketFeeCents: 0, ticketMax: 100 }), NOW).zeroCommission).toBe(false);
    // Con mantenimiento de la plataforma, o sin el precio calculado todavía, no se promete «0 %».
    expect(toCardData(row({ bracketFeeCents: 0, maintFeeCents: 4_900 }), NOW).zeroCommission).toBe(false);
    expect(toCardData(row({ bracketFeeCents: 0, quotaReservedAt: null }), NOW).zeroCommission).toBe(false);
  });

  it('en taquilla con gastos encima, la tarjeta anuncia lo que paga quien compra (precio + gestión digital)', () => {
    const fees = { ticketFeeFixedCents: 45, ticketFeeBps: 200 };
    const add = row({ format: 'TICKETING', ticketPriceCents: 500, ticketFeeMode: 'ADD', ticketMax: 100 });
    expect(toCardData(add, NOW, fees)).toMatchObject({ ticketPriceCents: 500, ticketBuyerCents: 555 });
    expect(toCardData({ ...add, ticketFeeMode: 'INC' }, NOW, fees).ticketBuyerCents).toBe(500);
    expect(toCardData(row(), NOW, fees).ticketBuyerCents).toBe(0);
  });

  it('una iniciativa conseguida o cerrada no admite aportaciones', () => {
    expect(toCardData(row({ status: 'GOAL_REACHED', raisedCents: 410_000 }), NOW)).toMatchObject({ achieved: true, closed: true });
    expect(toCardData(row({ status: 'CLOSED', raisedCents: 100 }), NOW)).toMatchObject({ achieved: false, closed: true });
  });

  it('el detalle no lleva fechas sin serializar ni datos internos de la entidad', () => {
    const detail = toDetailData(row({ courses: [{ groupName: '3º de Primaria', familiesCount: 28 }] }), { vertical: 'SCHOOL', participationGroupsJson: null, ticketFeeFixedCents: 45, ticketFeeBps: 200 }, NOW);
    expect(JSON.parse(JSON.stringify(detail))).toEqual(detail);
    expect(detail.closesAtIso).toBe(new Date(NOW.getTime() + 10 * DAY).toISOString());
    expect(detail.challenge.lines).toHaveLength(1);
    expect(Object.keys(detail)).not.toEqual(expect.arrayContaining(['costMatCents', 'bracketFeeCents', 'guaranteeContributionCents']));
    expect(JSON.stringify(detail)).not.toMatch(/@|donorTaxId|guestEmail|iban/i);
  });

  it('con el reto desactivado no se calcula ni se enseña ningún grupo', () => {
    const detail = toDetailData(row({ rewardEnabled: false, courses: [{ groupName: '3º de Primaria', familiesCount: 28 }] }), { vertical: 'SCHOOL', participationGroupsJson: null, ticketFeeFixedCents: 0, ticketFeeBps: 0 }, NOW);
    expect(detail.challenge).toMatchObject({ enabled: false, lines: [] });
  });

  it('el patrocinador del Matching solo se nombra mientras la bolsa siga activa', () => {
    const context = { vertical: 'SCHOOL', participationGroupsJson: null, ticketFeeFixedCents: 0, ticketFeeBps: 0 };
    expect(toDetailData(row({ matchingPoolRemainingCents: 500, matchingSponsorName: 'Ferretería Pepe' }), context, NOW).matchingSponsorName).toBe('Ferretería Pepe');
    expect(toDetailData(row({ matchingPoolRemainingCents: 0, matchingSponsorName: 'Ferretería Pepe' }), context, NOW).matchingSponsorName).toBeNull();
  });
});

describe('Idiomas del contenido de la entidad', () => {
  const base = { title: 'Ventiladores', description: 'Descripción en castellano', translationsJson: { ca: { title: 'Ventiladors', description: 'Descripció en català' }, en: { title: 'Fans' } } };

  it('usa la traducción de la persona si existe y la marca como texto en su idioma', () => {
    expect(localizeRow(base, 'ca', 'es')).toMatchObject({ row: { title: 'Ventiladors', description: 'Descripció en català' }, lang: undefined });
  });

  it('una traducción parcial completa lo que falta con el original y marca ese texto en su idioma', () => {
    const result = localizeRow(base, 'en', 'es');
    expect(result.row).toMatchObject({ title: 'Fans', description: 'Descripción en castellano' });
    expect(result.lang).toBe('es');
  });

  it('sin traducción devuelve el original marcado con el idioma en que se escribió, salvo que coincida con el de la página', () => {
    expect(localizeRow({ title: 'T', description: 'D' }, 'en', 'es')).toMatchObject({ row: { title: 'T' }, lang: 'es' });
    expect(localizeRow({ title: 'T', description: 'D' }, 'es', 'es').lang).toBeUndefined();
  });

  it('una traducción mal formada se ignora sin romper la página', () => {
    expect(localizeRow({ title: 'T', description: 'D', translationsJson: { ca: { title: 42 } } }, 'ca', 'es').row.title).toBe('T');
    expect(localizeRow({ title: 'T', description: 'D', translationsJson: 'x' }, 'ca', 'es').row.title).toBe('T');
  });
});
