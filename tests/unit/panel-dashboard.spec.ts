import { describe, expect, it } from 'vitest';
import { buildMedalSealSvg, entityHashtag, isKitAvailable, medalGrantStatus, medalHashtags, medalLevels, whatsappShareUrl, type MedalTier } from '@/core/medals/medal-kit';
import { buildMedalReportLines, renderMedalReportPdf, type MedalReportData } from '@/core/medals/medal-report';
import {
  NO_FILTERS,
  TIMELINE_STEPS,
  activeFilterCount,
  computeKpis,
  filterInitiatives,
  filterOptions,
  firstCampaignSteps,
  hasPublicPage,
  progressPercent,
  timelineStates,
  type DashboardInitiative
} from '@/core/panel/dashboard';
import { renderLinesPdf, wrapPdfText } from '@/core/pdf/text-pdf';
import { isValidContactPhone, normalizeContactPhone } from '@/core/tax/contact-phone';
import { model182Years } from '@/core/tax/model182-years';

/** Sprint 4.1 · cuadro de mandos, kit de medallas, Modelo 182 y escritor de PDF compartido (QA-S02, QA-S05). */

const initiative = (overrides: Partial<DashboardInitiative> = {}): DashboardInitiative => ({
  id: 1,
  walletEscrowId: 'WLT-ESC-AAAAAA',
  title: 'Ventiladores para las aulas',
  category: 'Infraestructura',
  academicYear: '2026-2027',
  format: 'BUDGET',
  status: 'FUNDRAISING',
  stepIndex: 4,
  raisedCents: 150_000,
  goalCents: 400_000,
  closesAt: '2026-12-31T23:00:00.000Z',
  totalContributions: 12,
  ...overrides
});

const TIERS: MedalTier[] = [
  { key: 'gold', name: 'Oro', icon: '🥇', rank: 3, campaignsRequired: 3, grantCents: 200_000 },
  { key: 'bronze', name: 'Bronce', icon: '🥉', rank: 1, campaignsRequired: 1, grantCents: 50_000 },
  { key: 'silver', name: 'Plata', icon: '🥈', rank: 2, campaignsRequired: 2, grantCents: 100_000 }
];

describe('filtros del cuadro de mandos', () => {
  const items = [
    initiative({ id: 1 }),
    initiative({ id: 2, academicYear: '2025-2026', category: 'Patios y Deporte', status: 'CLOSED', stepIndex: 5 }),
    initiative({ id: 3, status: 'GOAL_REACHED', stepIndex: 5, category: 'Taquilla y rifas', format: 'TICKETING' })
  ];

  it('sin filtros entra todo; cada filtro acota y se combinan', () => {
    expect(filterInitiatives(items, NO_FILTERS)).toHaveLength(3);
    expect(filterInitiatives(items, { ...NO_FILTERS, year: '2025-2026' }).map((item) => item.id)).toEqual([2]);
    expect(filterInitiatives(items, { ...NO_FILTERS, status: 'GOAL_REACHED' }).map((item) => item.id)).toEqual([3]);
    expect(filterInitiatives(items, { year: '2026-2027', category: 'Infraestructura', status: 'FUNDRAISING' }).map((item) => item.id)).toEqual([1]);
    expect(filterInitiatives(items, { year: '2025-2026', category: 'Infraestructura', status: 'ALL' })).toEqual([]);
  });

  it('el contador cuenta solo los filtros activos', () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
    expect(activeFilterCount({ year: '2026-2027', category: 'ALL', status: 'CLOSED' })).toBe(2);
    expect(activeFilterCount({ year: 'x', category: 'y', status: 'CLOSED' })).toBe(3);
  });

  it('las opciones salen de los datos: cursos del más reciente al más antiguo y categorías ordenadas', () => {
    expect(filterOptions(items)).toEqual({ years: ['2026-2027', '2025-2026'], categories: ['Infraestructura', 'Patios y Deporte', 'Taquilla y rifas'] });
  });
});

describe('indicadores', () => {
  it('cuentan activas, logros (conseguidas y cerradas) y recaudado', () => {
    const kpis = computeKpis([
      initiative({ raisedCents: 100_00 }),
      initiative({ id: 2, status: 'GOAL_REACHED', raisedCents: 200_00 }),
      initiative({ id: 3, status: 'CLOSED', raisedCents: 300_00 }),
      initiative({ id: 4, status: 'BUDGETING', raisedCents: 0 })
    ]);
    expect(kpis).toEqual({ total: 4, active: 1, achieved: 2, raisedCents: 600_00 });
  });

  it('lo devuelto o cancelado no suma al recaudado', () => {
    const kpis = computeKpis([initiative({ status: 'REFUNDED', raisedCents: 99_00 }), initiative({ id: 2, status: 'REFUNDING', raisedCents: 50_00 }), initiative({ id: 3, status: 'CANCELLED', raisedCents: 10_00 }), initiative({ id: 4, raisedCents: 25_00 })]);
    expect(kpis.raisedCents).toBe(25_00);
  });

  it('el avance se acota entre 0 y 100 y no divide por cero', () => {
    expect(progressPercent(150_000, 400_000)).toBe(37);
    expect(progressPercent(500_000, 400_000)).toBe(100);
    expect(progressPercent(-5, 400_000)).toBe(0);
    expect(progressPercent(100, 0)).toBe(0);
  });
});

describe('línea de 6 estados', () => {
  it('marca hechas, la actual y pendientes; un paso fuera de rango se acota', () => {
    expect(TIMELINE_STEPS).toHaveLength(6);
    expect(timelineStates(4)).toEqual(['done', 'done', 'done', 'done', 'current', 'pending']);
    expect(timelineStates(0)).toEqual(['current', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(timelineStates(5).filter((state) => state === 'done')).toHaveLength(5);
    expect(timelineStates(99)).toEqual(timelineStates(5));
    expect(timelineStates(-3)).toEqual(timelineStates(0));
  });

  it('solo tienen ficha pública las iniciativas que el portal enseña', () => {
    expect(['FUNDRAISING', 'GOAL_REACHED', 'CLOSED'].every((status) => hasPublicPage(status as never))).toBe(true);
    expect(['BUDGETING', 'EXPIRED', 'RESIZE_VOTING', 'REFUNDING', 'REFUNDED', 'CANCELLED'].some((status) => hasPublicPage(status as never))).toBe(false);
  });

  it('el estado vacío guiado pide las dos firmas, los documentos y, al final, el Estudio', () => {
    expect(firstCampaignSteps({ readySigners: 1, kybStatus: 'PENDING' })).toEqual([
      { key: 'signers', done: false },
      { key: 'documents', done: false },
      { key: 'studio', done: false }
    ]);
    expect(firstCampaignSteps({ readySigners: 2, kybStatus: 'VERIFIED' }).filter((step) => step.done).map((step) => step.key)).toEqual(['signers', 'documents']);
  });
});

describe('medallas', () => {
  it('ordena por rango y marca conseguida, siguiente y más adelante', () => {
    const levels = medalLevels(TIERS, 1, 1);
    expect(levels.map((level) => [level.key, level.state, level.campaignsMissing])).toEqual([
      ['bronze', 'EARNED', 0],
      ['silver', 'NEXT', 1],
      ['gold', 'LOCKED', 2]
    ]);
    expect(medalLevels(TIERS, 0, 0).map((level) => level.state)).toEqual(['NEXT', 'LOCKED', 'LOCKED']);
    expect(medalLevels(TIERS, 3, 5).every((level) => level.state === 'EARNED')).toBe(true);
  });

  it('el kit solo está disponible para una medalla ya conseguida', () => {
    const [bronze, silver, gold] = medalLevels(TIERS, 2, 2);
    expect([bronze, silver, gold].map((level) => isKitAvailable(level!))).toEqual([true, true, false]);
  });

  it('la beca se resume como aplicada, disponible o sin beca', () => {
    expect(medalGrantStatus({ availableCents: 0, usedInTitle: 'Climatización' })).toEqual({ kind: 'USED', title: 'Climatización' });
    expect(medalGrantStatus({ availableCents: 100_000, usedInTitle: null })).toEqual({ kind: 'AVAILABLE', cents: 100_000 });
    expect(medalGrantStatus({ availableCents: 0, usedInTitle: null })).toEqual({ kind: 'NONE' });
  });

  it('las etiquetas de redes no llevan acentos ni signos y el enlace de WhatsApp codifica el texto', () => {
    expect(entityHashtag('CEIP Cervantes')).toBe('#CEIPCervantes');
    expect(entityHashtag('Club Deportivo Basket Vallès')).toBe('#ClubDeportivoBasketValles');
    expect(entityHashtag('¡¿?!')).toBe('');
    expect(medalHashtags('IES Mediterráneo')).toBe('#ComunidadKORUM #IESMediterraneo');
    expect(medalHashtags('***')).toBe('#ComunidadKORUM');
    const url = whatsappShareUrl('Hola & adiós #1');
    expect(url.startsWith('https://wa.me/?text=')).toBe(true);
    expect(new URL(url).searchParams.get('text')).toBe('Hola & adiós #1');
  });

  it('el sello es un SVG con el nivel y la entidad, y escapa lo que pueda romper el XML', () => {
    const svg = buildMedalSealSvg({ rank: 2, tierName: 'Plata', entityName: 'CEIP "Cervantes" & <Co>', period: '2026-2027', headline: 'Comunidad Impulsora', accessibleName: 'Sello Plata' });
    expect(svg.startsWith('<?xml')).toBe(true);
    expect(svg).toContain('PLATA');
    expect(svg).toContain('COMUNIDAD IMPULSORA');
    expect(svg).toContain('CEIP &quot;Cervantes&quot; &amp; &lt;Co&gt;');
    expect(svg).not.toContain('<Co>');
    expect(svg).toContain('<title id="seal-title">Sello Plata</title>');
    const long = buildMedalSealSvg({ rank: 3, tierName: 'Oro', entityName: 'A'.repeat(80), period: '2026-2027', headline: 'x', accessibleName: 'y' });
    expect(long).not.toContain('A'.repeat(31));
  });
});

const t = (key: string, values: Record<string, string> = {}) => `${key}${Object.keys(values).length > 0 ? `|${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(',')}` : ''}`;
const report = (overrides: Partial<MedalReportData> = {}): MedalReportData => ({
  entityName: 'CEIP Cervantes',
  period: '2026-2027',
  tierName: 'Plata',
  completedCampaigns: 2,
  totalRaisedCents: 1_234_567,
  activeSponsors: 4,
  achievements: [{ title: 'Ventiladores', raisedCents: 400_000 }],
  generatedAt: new Date('2026-11-08T10:00:00Z'),
  locale: 'es',
  ...overrides
});

describe('informe de la medalla', () => {
  it('lleva las cifras reales con formato de importe y solo texto traducible', () => {
    const text = buildMedalReportLines(report(), t).map((line) => line.text).join('\n');
    expect(text).toContain('impact.campaigns|count=2');
    expect(text).toContain('12.345,67');
    expect(text).toContain('impact.sponsors|count=4');
    expect(text).toContain('Ventiladores: 4.000,00');
    expect(text).toContain('generatedAt|date=8 de noviembre de 2026');
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('sin campañas dice que todavía no hay ninguna y el PDF es un PDF válido', () => {
    const lines = buildMedalReportLines(report({ achievements: [], completedCampaigns: 0, totalRaisedCents: 0 }), t).map((line) => line.text);
    expect(lines).toContain('achievementsEmpty');
    const bytes = renderMedalReportPdf(report(), t);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Count 1');
  });
});

describe('escritor de PDF compartido', () => {
  it('parte las líneas sin cortar palabras y reparte en varias páginas', () => {
    expect(wrapPdfText('uno dos tres cuatro', 9)).toEqual(['uno dos', 'tres', 'cuatro']);
    expect(wrapPdfText('', 10)).toEqual(['']);
    const pdf = new TextDecoder().decode(renderLinesPdf(Array.from({ length: 200 }, (_, index) => ({ style: 'body' as const, text: `línea ${index}` }))));
    expect(pdf).toMatch(/\/Count [2-9]/);
  });

  it('escapa paréntesis y barras, y los bytes altos van en octal (PDF de ASCII puro)', () => {
    const pdf = new TextDecoder().decode(renderLinesPdf([{ style: 'body', text: 'a (b) \\ ñ €' }]));
    expect(pdf).toContain('\\(b\\)');
    expect(pdf).toContain('\\\\');
    expect(pdf).toContain('\\361');
    expect(pdf).toContain('\\200');
    expect(/^[\x00-\x7f]*$/.test(pdf)).toBe(true);
  });
});

describe('Modelo 182: teléfono y ejercicios', () => {
  it('normaliza el teléfono a 9 cifras sin prefijo ni separadores', () => {
    expect(normalizeContactPhone('+34 934 12 88 90')).toBe('934128890');
    expect(normalizeContactPhone('0034-934.128.890')).toBe('934128890');
    expect(normalizeContactPhone('(934) 12 88 90')).toBe('934128890');
    expect(isValidContactPhone('934 12 88 90')).toBe(true);
    expect(isValidContactPhone('93412889')).toBe(false);
    expect(isValidContactPhone('93412889012')).toBe(false);
    expect(isValidContactPhone('93412889a')).toBe(false);
    expect(isValidContactPhone('')).toBe(false);
  });

  it('ofrece del ejercicio en curso hasta 2024 y propone el último completo; el año lo decide la hora de España', () => {
    expect(model182Years(new Date('2026-11-08T10:00:00Z'))).toEqual({ years: [2026, 2025, 2024], defaultYear: 2025 });
    // 31 de diciembre a las 23:30 UTC ya es 1 de enero en España.
    expect(model182Years(new Date('2026-12-31T23:30:00Z'))).toEqual({ years: [2027, 2026, 2025, 2024], defaultYear: 2026 });
    // Nunca por debajo del primer ejercicio admitido.
    expect(model182Years(new Date('2024-06-01T00:00:00Z'))).toEqual({ years: [2024], defaultYear: 2024 });
  });
});
