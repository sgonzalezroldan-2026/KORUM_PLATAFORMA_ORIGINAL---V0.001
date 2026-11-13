import { describe, expect, it } from 'vitest';
import { CAMPAIGN_TEMPLATES, draftFromTemplate, templatesFor } from '@/core/studio/campaign-templates';
import { canPrintPoster, printedUrl } from '@/core/studio/poster-rules';
import { computeBudgetBoard, computeStudioBoard, computeTicketingBoard, effectiveMaxCampaignDays, evaluateStudioLock, latestCloseOn, publishBlockers, saveProblems, storedBudgetBoard, type StudioContext } from '@/core/studio/studio-board';
import { blankStudioDraft, defaultCloseOn, endOfDayInMadrid, madridIsoDate, studioDraftSchema, TICKETING_CATEGORY, type StudioDraft } from '@/core/studio/studio-draft';
import { evaluateSemanticLock } from '@/core/security/semantic-lock';
import ca from '../../messages/ca.json';
import en from '../../messages/en.json';
import es from '../../messages/es.json';

/**
 * QA-S01 · Estudio dual (Sprint 4.3). La pizarra es el motor TCO de siempre; aquí se comprueba lo que añade el Estudio: qué entradas elige, la meta de
 * taquilla (con `INC` también), el candado semántico en vivo, las fechas en hora de España y la lista de lo que falta para publicar.
 */

const NOW = new Date('2026-11-10T10:00:00Z');

const CATEGORIES: StudioContext['categories'] = [
  { name: 'Infraestructura y Confort', icon: '🌡️', rule: 'BRACKETS' },
  { name: 'Patios y Deporte', icon: '🏀', rule: 'BRACKETS' },
  { name: 'Tecnología y Recursos', icon: '💻', rule: 'BRACKETS' },
  { name: 'Comunidad y Viajes', icon: '🎒', rule: 'EXEMPT' },
  { name: 'Solidaridad y Becas', icon: '💚', rule: 'EXEMPT' },
  { name: TICKETING_CATEGORY, icon: '🎟️', rule: 'EXEMPT' }
];

function context(overrides: Partial<StudioContext> = {}): StudioContext {
  return {
    vertical: 'SCHOOL',
    bracket: { mode: 'FLAT', t1MaxCents: 500_000, t2MaxCents: 1_500_000, ratesBps: { t1: 500, t2: 400, t3: 300 } },
    gateway: { pctBps: 100, fixedCents: 9 },
    donationTicketCents: 2500,
    exemptRemainingCents: 100_000,
    medalGrantAvailableCents: 0,
    medalRank: 0,
    maint: { active: false, perInitCents: 4900, annualCapCents: 14_700, paidCents: 0 },
    ticketFee: { fixedCents: 45, pctBps: 200 },
    maxCampaignDays: 60,
    categories: CATEGORIES,
    kybVerified: true,
    ...overrides
  };
}

function budget(overrides: Partial<StudioDraft> = {}): StudioDraft {
  return { ...blankStudioDraft('BUDGET', 'SCHOOL', '2026-12-10'), title: 'Aulas más frescas', description: 'Ventilación para las aulas', category: 'Infraestructura y Confort', costMatCents: 380_000, costInstCents: 130_000, ...overrides };
}

function ticketing(overrides: Partial<StudioDraft> = {}): StudioDraft {
  return { ...blankStudioDraft('TICKETING', 'SCHOOL', '2026-12-10'), title: 'Festival', description: 'Entradas con QR', ...overrides };
}

describe('QA-S01 · pizarra de presupuesto', () => {
  it('cuadra al céntimo con una meta en euros enteros (caso calculado a mano)', () => {
    const board = computeBudgetBoard(context(), budget());
    // 5.100,00 € + 10 % = 5.610,00 €; 1.000,00 € exentos; resto 4.610,00 € al 4 % (tramo 2 del neto) = 184,40 €; 232 cobros de 25 €.
    expect(board.netCents).toBe(561_000);
    expect(board.defaultExemptCents).toBe(100_000);
    expect(board.rateBps).toBe(400);
    expect(board.bracketFeeCents).toBe(18_440);
    expect(board.gatewayFeeCents).toBe(7_960);
    expect(board.goalCents).toBe(587_400);
    expect(board.netCents + board.bracketFeeCents + board.maintFeeCents + board.gatewayFeeCents).toBe(board.goalCents);
  });

  it('con 1.000 presupuestos aleatorios, las líneas suman siempre la meta y la meta es un euro entero', () => {
    let seed = 20_261_110;
    const next = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    for (let index = 0; index < 1000; index += 1) {
      const draft = budget({ costMatCents: Math.floor(next() * 5_000_000), costInstCents: Math.floor(next() * 1_000_000), contingencyBps: Math.floor(next() * 3001) });
      const ctx = context({ maint: { active: next() > 0.5, perInitCents: 4900, annualCapCents: 14_700, paidCents: Math.floor(next() * 15_000) }, exemptRemainingCents: Math.floor(next() * 200_000), medalGrantAvailableCents: [0, 50_000, 100_000, 200_000][Math.floor(next() * 4)]! });
      const board = computeBudgetBoard(ctx, draft);
      expect(board.netCents + board.bracketFeeCents + board.maintFeeCents + board.gatewayFeeCents).toBe(board.goalCents);
      expect(board.goalCents % 100).toBe(0);
    }
  });

  it('el mantenimiento a 0 se queda en 0 € (nunca «desactivado») y con el tope alcanzado también', () => {
    expect(computeBudgetBoard(context(), budget()).maintFeeCents).toBe(0);
    const capped = computeBudgetBoard(context({ maint: { active: true, perInitCents: 4900, annualCapCents: 14_700, paidCents: 14_700 } }), budget());
    expect(capped.maintFeeCents).toBe(0);
    const partial = computeBudgetBoard(context({ maint: { active: true, perInitCents: 4900, annualCapCents: 14_700, paidCents: 12_000 } }), budget());
    expect(partial.maintFeeCents).toBe(2700);
  });

  it('una beca de medalla se descuenta del resto sujeto y enseña su ahorro exacto', () => {
    const without = computeBudgetBoard(context(), budget());
    const withMedal = computeBudgetBoard(context({ medalGrantAvailableCents: 100_000, medalRank: 2 }), budget());
    expect(withMedal.medalExemptCents).toBe(100_000);
    expect(withMedal.bracketFeeCents).toBe(without.bracketFeeCents - 4000);
    expect(withMedal.medalSavedCents).toBe(4000);
  });

  it('la pizarra de una campaña ya publicada sale de lo guardado, sin tocar los cupos', () => {
    const live = computeBudgetBoard(context(), budget());
    const frozen = storedBudgetBoard({
      costMatCents: 380_000,
      costInstCents: 130_000,
      contingencyBps: 1000,
      goalCents: live.goalCents,
      defaultExemptAppliedCents: live.defaultExemptCents,
      medalExemptAppliedCents: 0,
      bracketRateAppliedBps: live.rateBps,
      bracketFeeCents: live.bracketFeeCents,
      maintFeeCents: 0,
      gatewayFeeCents: live.gatewayFeeCents
    });
    expect(frozen.goalCents).toBe(live.goalCents);
    expect(frozen.netCents + frozen.bracketFeeCents + frozen.maintFeeCents + frozen.gatewayFeeCents).toBe(frozen.goalCents);
    expect(frozen.gatewayDetail).toBeNull();
  });
});

describe('QA-S01 · candado semántico en vivo', () => {
  const lock = (title: string, description: string, category = 'Comunidad y Viajes') => evaluateStudioLock(context(), { title, description, category });

  it('«cobrar» y «obra de teatro» no bloquean el 0 %; «ventiladores» y «toldos» sí', () => {
    expect(lock('Cobrar la cuota de la excursión', 'Salida de fin de curso').blocked).toBe(false);
    expect(lock('Función de fin de curso', 'Representamos una obra de teatro con las familias').blocked).toBe(false);
    expect(lock('Ventiladores para el comedor', 'Es una excursión').blocked).toBe(true);
    expect(lock('Excursión', 'Compraremos toldos para el patio').blocked).toBe(true);
  });

  it('una categoría con tramos no pide el candado, y una bloqueada paga la comisión por tramos', () => {
    expect(lock('Ventiladores', 'aulas', 'Infraestructura y Confort')).toEqual({ requested: false, blocked: false, term: null });
    const blocked = computeBudgetBoard(context(), budget({ category: 'Comunidad y Viajes', title: 'Ventiladores para el comedor' }));
    expect(blocked.categoryExempt).toBe(false);
    expect(blocked.lock.blocked).toBe(true);
    expect(blocked.bracketFeeCents).toBeGreaterThan(0);
    const exempt = computeBudgetBoard(context(), budget({ category: 'Comunidad y Viajes', title: 'Excursión de fin de curso', description: 'Autocar y entradas' }));
    expect(exempt.categoryExempt).toBe(true);
    expect(exempt.bracketFeeCents).toBe(0);
    expect(exempt.defaultExemptCents).toBe(0);
  });
});

describe('QA-S01 · taquilla y rifa', () => {
  it('QA-FIN03: entrada de 5,00 € con gestión de 0,55 € sumada al comprador deja un margen de +0,40 €', () => {
    const board = computeTicketingBoard(context(), ticketing());
    expect(board.digitalFeeUnitCents).toBe(55);
    expect(board.buyerUnitChargeCents).toBe(555);
    expect(board.gatewayUnitCostCents).toBe(15);
    expect(board.marginPerTicketCents).toBe(40);
    expect(board.isGatewayCovered).toBe(true);
    expect(board.goalCents).toBe(100_000);
  });

  it('con los gastos incluidos en el precio (`INC`) la meta es lo que entra de verdad en la hucha, para poder llegar al 100 %', () => {
    const add = computeTicketingBoard(context(), ticketing({ ticketFeeMode: 'ADD' }));
    const inc = computeTicketingBoard(context(), ticketing({ ticketFeeMode: 'INC' }));
    expect(add.goalCents).toBe(200 * 500);
    expect(inc.goalCents).toBe(200 * (500 - 55));
    expect(inc.goalCents).toBe(inc.grossCents - inc.totalDigitalFeesCents);
  });

  it('el mantenimiento que la recaudación no cubre se avisa en lugar de esconderse en un neto a 0', () => {
    const board = computeTicketingBoard(context({ maint: { active: true, perInitCents: 4900, annualCapCents: 14_700, paidCents: 0 } }), ticketing({ ticketPriceCents: 100, ticketMax: 10 }));
    expect(board.maintFeeCents).toBe(4900);
    expect(board.netCents).toBe(0);
    expect(board.maintShortfallCents).toBeGreaterThan(0);
  });

  it('`computeStudioBoard` elige la pizarra según el formato', () => {
    expect(computeStudioBoard(context(), budget()).kind).toBe('BUDGET');
    expect(computeStudioBoard(context(), ticketing()).kind).toBe('TICKETING');
  });
});

describe('QA-S01 · fechas y duración máxima', () => {
  it('el día de cierre acaba a las 23:59 de España, con horario de invierno y de verano', () => {
    expect(endOfDayInMadrid('2026-12-15')?.toISOString()).toBe('2026-12-15T22:59:00.000Z');
    expect(endOfDayInMadrid('2027-07-15')?.toISOString()).toBe('2027-07-15T21:59:00.000Z');
    expect(endOfDayInMadrid('2027-02-30')).toBeNull();
    expect(endOfDayInMadrid('texto')).toBeNull();
  });

  it('madridIsoDate usa la hora de España: a las 23:30 UTC de diciembre ya es el día siguiente', () => {
    expect(madridIsoDate(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    expect(defaultCloseOn(new Date('2026-11-10T10:00:00Z'), 30)).toBe('2026-12-10');
  });

  it('no se guarda una campaña que dure más de `maxCampaignDays` ni con el cierre ya pasado', () => {
    expect(saveProblems(context(), budget({ closesOn: '2027-03-01' }), NOW)).toContain('CLOSING_TOO_LATE');
    expect(saveProblems(context(), budget({ closesOn: '2026-11-09' }), NOW)).toContain('CLOSING_PAST');
    expect(saveProblems(context(), budget({ closesOn: '2026-12-10' }), NOW)).toEqual([]);
    // Con reglas extremas la meta calculada no puede pasar de lo que cabe en un entero de la base de datos: se avisa en vez de fallar al guardar.
    const extreme = context({ gateway: { pctBps: 100, fixedCents: 10_000 }, donationTicketCents: 500 });
    expect(saveProblems(extreme, budget({ costMatCents: 50_000_000, costInstCents: 50_000_000, contingencyBps: 3_000 }), NOW)).toContain('GOAL_TOO_HIGH');
    expect(saveProblems(context(), budget({ costMatCents: 50_000_000, costInstCents: 50_000_000, contingencyBps: 3_000 }), NOW)).not.toContain('GOAL_TOO_HIGH');
    // El cierre es a las 23:59 de España: el último día que cabe en 60 días es el 8 de enero y el siguiente ya no.
    expect(latestCloseOn(NOW, 60)).toBe('2027-01-08');
    expect(saveProblems(context(), budget({ closesOn: '2027-01-08' }), NOW)).toEqual([]);
    expect(saveProblems(context(), budget({ closesOn: '2027-01-09' }), NOW)).toContain('CLOSING_TOO_LATE');
  });

  it('el último día del selector no se salta una fecha válida con el cambio de hora de marzo', () => {
    // 60 días desde el 28 de enero a las 23:00 (España): el 29 de marzo (23 horas de día por el cambio de hora) todavía cabe.
    const now = new Date('2026-01-28T22:00:00Z');
    const last = latestCloseOn(now, 60);
    expect(saveProblems(context(), budget({ closesOn: last }), now)).not.toContain('CLOSING_TOO_LATE');
    const next = new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)) - 1, Number(last.slice(8, 10)) + 1)).toISOString().slice(0, 10);
    expect(saveProblems(context(), budget({ closesOn: next }), now)).toContain('CLOSING_TOO_LATE');
  });

  it('el tope de 75 días no lo sube ni un ajuste mayor de la consola', () => {
    expect(effectiveMaxCampaignDays(60)).toBe(60);
    expect(effectiveMaxCampaignDays(200)).toBe(75);
    expect(saveProblems(context({ maxCampaignDays: 200 }), budget({ closesOn: '2027-02-10' }), NOW)).toContain('CLOSING_TOO_LATE');
  });

  it('una categoría que no existe, o la de taquilla en un presupuesto, no se guarda', () => {
    expect(saveProblems(context(), budget({ category: 'Inventada' }), NOW)).toContain('INVALID_CATEGORY');
    expect(saveProblems(context(), budget({ category: TICKETING_CATEGORY }), NOW)).toContain('INVALID_CATEGORY');
    expect(saveProblems(context(), ticketing({ category: 'Patios y Deporte' }), NOW)).toContain('INVALID_CATEGORY');
  });
});

describe('QA-S01 · qué falta para publicar', () => {
  const blockers = (draft: StudioDraft, ctx = context()) => publishBlockers(ctx, draft, computeStudioBoard(ctx, draft), NOW);

  it('un presupuesto completo no tiene nada pendiente', () => {
    expect(blockers(budget())).toEqual([]);
  });

  it('exige meta, curso, descripción y documentos verificados del titular', () => {
    expect(blockers(budget({ costMatCents: 0, costInstCents: 0 }))).toContain('GOAL_ZERO');
    expect(blockers(budget({ stage: '' }))).toContain('STAGE_MISSING');
    expect(blockers(budget(), context({ kybVerified: false }))).toContain('KYB');
    expect(blockers({ ...budget(), description: '   ' })).toContain('DESCRIPTION_MISSING');
  });

  it('una rifa necesita premios (no más que papeletas) y la confirmación de normativa', () => {
    const raffle = ticketing({ ticketSubtype: 'RAFFLE', ticketPriceCents: 200, ticketMax: 500, rafflePrizeCount: null, raffleNoticeConfirmed: false });
    expect(blockers(raffle)).toEqual(expect.arrayContaining(['RAFFLE_PRIZES', 'RAFFLE_NOTICE']));
    expect(blockers({ ...raffle, rafflePrizeCount: 3 })).toEqual(['RAFFLE_NOTICE']);
    expect(blockers({ ...raffle, rafflePrizeCount: 3, raffleNoticeConfirmed: true })).toEqual([]);
    expect(blockers({ ...raffle, rafflePrizeCount: 600, raffleNoticeConfirmed: true })).toContain('RAFFLE_PRIZES_EXCEED');
    // Un evento con entradas no lleva aviso de rifa.
    expect(blockers(ticketing())).toEqual([]);
  });

  it('no admite entradas sin importe para la hucha: precio 0, o `INC` con un precio que no supera los gastos', () => {
    expect(blockers(ticketing({ ticketPriceCents: 0 }))).toContain('TICKET_PRICE_ZERO');
    expect(blockers(ticketing({ ticketMax: 0 }))).toContain('TICKET_MAX_ZERO');
    // Con 0,46 € el gasto de gestión es de 0,46 € (45 cts + 2 % redondeado): no queda nada para la hucha.
    expect(blockers(ticketing({ ticketFeeMode: 'INC', ticketPriceCents: 46 }))).toContain('TICKET_FEE_EXCEEDS_PRICE');
    expect(blockers(ticketing({ ticketFeeMode: 'INC', ticketPriceCents: 47 }))).toEqual([]);
    expect(blockers(ticketing({ ticketFeeMode: 'ADD', ticketPriceCents: 55 }))).toEqual([]);
  });

  it('un evento cuyo mantenimiento no cubre lo recaudable no se publica (la liquidación saldría en negativo)', () => {
    const ctx = context({ maint: { active: true, perInitCents: 4900, annualCapCents: 14_700, paidCents: 0 } });
    expect(blockers(ticketing({ ticketPriceCents: 100, ticketMax: 10 }), ctx)).toContain('MAINT_EXCEEDS_TAKINGS');
    expect(blockers(ticketing({ ticketPriceCents: 500, ticketMax: 200 }), ctx)).toEqual([]);
  });

  it('el candado semántico avisa pero no impide publicar (la comisión se cobra por tramos)', () => {
    expect(blockers(budget({ category: 'Comunidad y Viajes', title: 'Ventiladores' }))).toEqual([]);
  });
});

describe('QA-S01 · borrador y esquema', () => {
  it('un borrador en blanco de cada formato es válido para el esquema salvo lo que la persona debe escribir', () => {
    const blank = blankStudioDraft('BUDGET', 'SPORTS_CLUB', '2026-12-10');
    expect(blank.stage).toBe('Todo el club');
    expect(studioDraftSchema.safeParse({ ...blank, title: 'Título', category: 'Patios y Deporte', description: 'Algo' }).success).toBe(true);
    // Un borrador a medias se admite en el esquema: lo que falta lo dice cada aviso junto a su campo (`TITLE_MISSING`, `STAGE_MISSING`…), no un error genérico.
    expect(studioDraftSchema.safeParse(blank).success).toBe(true);
    expect(saveProblems(context(), { ...blank, category: 'Patios y Deporte' }, NOW)).toContain('TITLE_MISSING');
    expect(saveProblems(context(), { ...blank, title: 'Ab', category: 'Patios y Deporte' }, NOW)).toContain('TITLE_MISSING');
    expect(saveProblems(context(), { ...blank, title: 'Abc', category: 'Patios y Deporte' }, NOW)).not.toContain('TITLE_MISSING');
  });

  it('el esquema rechaza campos desconocidos (nada de cifras calculadas enviadas por el navegador) e importes con decimales', () => {
    const valid = { ...budget() };
    expect(studioDraftSchema.safeParse({ ...valid, goalCents: 1 }).success).toBe(false);
    expect(studioDraftSchema.safeParse({ ...valid, costMatCents: 10.5 }).success).toBe(false);
    expect(studioDraftSchema.safeParse({ ...valid, costMatCents: -1 }).success).toBe(false);
    expect(studioDraftSchema.safeParse({ ...valid, rafflePrizeCount: 0 }).success).toBe(false);
    expect(studioDraftSchema.safeParse({ ...valid, contingencyBps: 3001 }).success).toBe(false);
    expect(studioDraftSchema.safeParse({ ...valid, initiativeId: 3_000_000_000 }).success).toBe(false);
  });

  it('rechaza caracteres de control, de dirección de texto y de ancho cero en lo que acaba en la ficha pública y el cartel', () => {
    const valid = { ...budget() };
    for (const bad of ['Aulas\u202Eabc', 'Au\u200Blas', 'Aulas\u0000', 'Aulas\u2066x']) {
      expect(studioDraftSchema.safeParse({ ...valid, title: bad }).success, JSON.stringify(bad)).toBe(false);
      expect(studioDraftSchema.safeParse({ ...valid, ticketVenue: bad }).success, JSON.stringify(bad)).toBe(false);
    }
    // La descripción admite saltos de línea; un tabulador o un salto no son un truco.
    expect(studioDraftSchema.safeParse({ ...valid, description: 'Línea uno\nLínea dos' }).success).toBe(true);
  });
});

describe('QA-S01 · plantillas de campaña', () => {
  const catalogs = { es, ca, en } as const;

  it('cada vertical tiene plantillas de mejora y de taquilla, y ninguna lleva un presupuesto de proveedor', () => {
    for (const vertical of ['SCHOOL', 'SPORTS_CLUB', 'CULTURAL'] as const) {
      const templates = templatesFor(vertical);
      expect(templates.some((template) => template.format === 'BUDGET'), vertical).toBe(true);
      expect(templates.some((template) => template.ticket?.subtype === 'RAFFLE'), vertical).toBe(true);
      expect(templates.some((template) => template.ticket?.subtype === 'EVENT'), vertical).toBe(true);
    }
    const draft = draftFromTemplate(CAMPAIGN_TEMPLATES[0]!, { title: 'T', description: 'D', rewardText: null }, { vertical: 'SCHOOL', defaultCloseOn: '2026-12-10', availableCategories: CATEGORIES.map((category) => category.name) });
    expect(draft.costMatCents).toBe(0);
    expect(draft.costInstCents).toBe(0);
  });

  it('todas las plantillas tienen sus textos en los tres idiomas', () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const template of CAMPAIGN_TEMPLATES) {
        const texts = (catalog.panel.studio.templates as Record<string, Record<string, string>>)[template.key];
        for (const field of ['name', 'summary', 'title', 'description']) expect(texts?.[field]?.trim(), `${locale}:${template.key}.${field}`).toBeTruthy();
      }
    }
  });

  it('las plantillas de categorías al 0 % pasan el candado semántico en castellano, catalán e inglés', () => {
    const exemptNames = new Set(CATEGORIES.filter((category) => category.rule === 'EXEMPT').map((category) => category.name));
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const template of CAMPAIGN_TEMPLATES) {
        if (template.category === null || !exemptNames.has(template.category)) continue;
        const texts = (catalog.panel.studio.templates as Record<string, Record<string, string>>)[template.key]!;
        expect(evaluateSemanticLock(`${texts.title} ${texts.description}`).isBlocked, `${locale}:${template.key}`).toBe(false);
      }
    }
  });

  it('si la entidad no tiene la categoría de la plantilla, queda por elegir; la taquilla usa la suya y sus valores de partida', () => {
    const raffle = CAMPAIGN_TEMPLATES.find((template) => template.key === 'raffle')!;
    const draft = draftFromTemplate(raffle, { title: 'R', description: 'D', rewardText: 'P' }, { vertical: 'SCHOOL', defaultCloseOn: '2026-12-10', availableCategories: [] });
    expect(draft).toMatchObject({ format: 'TICKETING', category: TICKETING_CATEGORY, ticketSubtype: 'RAFFLE', ticketPriceCents: 200, ticketMax: 500, rafflePrizeCount: 3 });
    const climate = CAMPAIGN_TEMPLATES.find((template) => template.key === 'climate')!;
    expect(draftFromTemplate(climate, { title: 'C', description: 'D', rewardText: null }, { vertical: 'SCHOOL', defaultCloseOn: '2026-12-10', availableCategories: [] }).category).toBe('');
  });
});

describe('QA-S01 · cartel A4', () => {
  it('solo una campaña recaudando tiene cartel (su ficha pública existe), y la dirección impresa no lleva `https://`', () => {
    expect(canPrintPoster('FUNDRAISING')).toBe(true);
    for (const status of ['BUDGETING', 'GOAL_REACHED', 'CLOSED', 'EXPIRED', 'REFUNDED', 'CANCELLED']) expect(canPrintPoster(status), status).toBe(false);
    expect(printedUrl('https://korum.es/cervantes/iniciativas/12')).toBe('korum.es/cervantes/iniciativas/12');
    expect(printedUrl('http://localhost:3000/ca/x/')).toBe('localhost:3000/ca/x');
  });
});
