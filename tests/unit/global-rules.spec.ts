import { describe, expect, it } from 'vitest';
import { hasLinkOrAddress, isNoteClosedAlertType, directEmailSchema, rectificationCloseSchema, rectifyNameSchema, resolveWithNoteSchema, splitResolutionSchema } from '@/core/admin/console-support-rules';
import {
  changedRuleKeys,
  changesTicketFee,
  GLOBAL_RULE_LIMITS,
  globalRulesSchema,
  invalidRuleFields,
  medalsSchema,
  pricingAcknowledgeTarget,
  pricingRulesOf,
  type GlobalRulesInput
} from '@/core/admin/global-rules';
import { evaluatePricingHealth, sampleTicketMargin } from '@/core/finance/pricing-health';
import { NUMERIC_FIELDS, parseField, parseState, stateOf, fieldDef } from '@/components/admin/global-rules-model';

/** Los valores por defecto de la semilla y de `GlobalConfig` (los del prototipo): son lo que ve el Super-Admin al abrir el motor de reglas. */
const DEFAULTS: GlobalRulesInput = {
  exemptLimitCents: 100_000,
  bracketMode: 'FLAT',
  t1MaxCents: 500_000,
  t2MaxCents: 1_500_000,
  t1Bps: 500,
  t2Bps: 400,
  t3Bps: 300,
  sponsorFeeBps: 1_500,
  fullIntegrityCheckCents: 180,
  guaranteePresetsCents: [0, 100, 200, 400],
  defaultGuaranteeIdx: 2,
  gatewayPctBps: 100,
  gatewayFixedCents: 9,
  topupFeeCents: 25,
  topupFeeBps: 0,
  ticketFeeFixedCents: 45,
  ticketFeeBps: 200,
  maintActive: false,
  maintPerInitCents: 4_900,
  maintAnnualCapCents: 14_700,
  maxCampaignDays: 60,
  creditPoolMaxDays: 60
};

describe('QA-A04 · reglas globales: los datos imposibles se rechazan, los precios que pierden dinero no', () => {
  it('los valores por defecto son válidos', () => {
    expect(globalRulesSchema.safeParse(DEFAULTS).success).toBe(true);
  });

  it.each([
    ['decimales en un importe', { ...DEFAULTS, topupFeeCents: 25.5 }, 'topupFeeCents'],
    ['importe negativo', { ...DEFAULTS, gatewayFixedCents: -1 }, 'gatewayFixedCents'],
    ['valor no numérico', { ...DEFAULTS, t1Bps: Number.NaN }, 't1Bps'],
    ['porcentaje por encima del 100 %', { ...DEFAULTS, sponsorFeeBps: 10_001 }, 'sponsorFeeBps'],
    ['campaña de más de 75 días', { ...DEFAULTS, maxCampaignDays: 76 }, 'maxCampaignDays'],
    ['campaña de 0 días', { ...DEFAULTS, maxCampaignDays: 0 }, 'maxCampaignDays'],
    ['bolsa de más de 70 días (el CHECK de la base de datos)', { ...DEFAULTS, creditPoolMaxDays: 71 }, 'creditPoolMaxDays'],
    ['tres niveles de garantía en vez de cuatro', { ...DEFAULTS, guaranteePresetsCents: [0, 100, 200] }, 'guaranteePresetsCents'],
    ['nivel por defecto fuera de los cuatro', { ...DEFAULTS, defaultGuaranteeIdx: 4 }, 'defaultGuaranteeIdx'],
    ['modo de tramos desconocido', { ...DEFAULTS, bracketMode: 'OTHER' }, 'bracketMode'],
    ['mantenimiento no booleano', { ...DEFAULTS, maintActive: 'yes' }, 'maintActive'],
    ['umbral por encima del límite', { ...DEFAULTS, t2MaxCents: GLOBAL_RULE_LIMITS.thresholdCents + 1 }, 't2MaxCents']
  ])('rechaza %s y dice qué campo', (_name, input, field) => {
    const result = globalRulesSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(invalidRuleFields(result.error)).toContain(field);
  });

  it('rechaza un campo de más y uno que falta: el cliente no puede colar columnas ni dejar reglas a medias', () => {
    expect(globalRulesSchema.safeParse({ ...DEFAULTS, id: 'OTRA' }).success).toBe(false);
    const { maintActive: _maintActive, ...incomplete } = DEFAULTS;
    expect(globalRulesSchema.safeParse(incomplete).success).toBe(false);
  });

  it('NO bloquea combinaciones que pierden dinero o son incoherentes: eso lo avisa la salud de precios', () => {
    const losing: GlobalRulesInput = { ...DEFAULTS, topupFeeCents: 0, ticketFeeFixedCents: 0, ticketFeeBps: 0, sponsorFeeBps: 0, t1Bps: 100, t2Bps: 400, t3Bps: 900, t1MaxCents: 2_000_000, t2MaxCents: 1_000_000 };
    expect(globalRulesSchema.safeParse(losing).success).toBe(true);
    const codes = evaluatePricingHealth(pricingRulesOf(losing)).map((alert) => alert.code);
    expect(codes).toEqual(expect.arrayContaining(['HUCHA_FEE_BELOW_GATEWAY_COST', 'TICKET_FEE_BELOW_GATEWAY_COST', 'SPONSOR_FEE_BELOW_GATEWAY_COST', 'BRACKET_THRESHOLDS_INVALID', 'BRACKET_RATES_NOT_DECREASING']));
  });

  it('con los valores por defecto saltan exactamente los dos avisos que prevé la skill: Hucha y escalón', () => {
    expect(evaluatePricingHealth(pricingRulesOf(DEFAULTS)).map((alert) => alert.code).sort()).toEqual(['BRACKET_CLIFF', 'HUCHA_FEE_BELOW_GATEWAY_COST']);
  });

  it('pricingRulesOf quita las duraciones: la salud de precios solo mira precios', () => {
    const pricing = pricingRulesOf(DEFAULTS);
    expect(pricing).not.toHaveProperty('maxCampaignDays');
    expect(pricing).not.toHaveProperty('creditPoolMaxDays');
    expect(pricing.gatewayPctBps).toBe(100);
  });

  it('changedRuleKeys solo lista lo que cambia, también en la lista de niveles; changesTicketFee mira los dos campos de los gastos de gestión', () => {
    expect(changedRuleKeys(DEFAULTS, DEFAULTS)).toEqual([]);
    const next = { ...DEFAULTS, t1Bps: 600, guaranteePresetsCents: [0, 100, 200, 500] };
    expect(changedRuleKeys(DEFAULTS, next).sort()).toEqual(['guaranteePresetsCents', 't1Bps']);
    expect(changesTicketFee(DEFAULTS, next)).toBe(false);
    expect(changesTicketFee(DEFAULTS, { ...DEFAULTS, ticketFeeBps: 250 })).toBe(true);
    expect(changesTicketFee(DEFAULTS, { ...DEFAULTS, ticketFeeFixedCents: 50 })).toBe(true);
  });
});

describe('validador en vivo de los gastos de gestión digital (QA-FIN03)', () => {
  it('con los valores por defecto, una entrada de 5 € cobra 0,55 €, la pasarela cuesta 0,15 € y quedan +0,40 €', () => {
    expect(sampleTicketMargin(DEFAULTS)).toEqual({ priceCents: 500, feeCents: 55, gatewayCostCents: 15, marginCents: 40 });
  });

  it('con gastos que no cubren la pasarela el margen es negativo (el aviso con la cifra lo da la salud de precios)', () => {
    const sample = sampleTicketMargin({ ...DEFAULTS, ticketFeeFixedCents: 0, ticketFeeBps: 0 });
    expect(sample?.marginCents).toBe(-14);
  });

  it('nunca lanza con valores todavía imposibles mientras se escribe: devuelve null', () => {
    expect(sampleTicketMargin({ ...DEFAULTS, ticketFeeBps: Number.NaN })).toBeNull();
    expect(sampleTicketMargin({ ...DEFAULTS, gatewayFixedCents: -3 })).toBeNull();
    expect(sampleTicketMargin({ ...DEFAULTS, ticketFeeFixedCents: 1.5 })).toBeNull();
  });
});

describe('modelo del formulario: texto de la persona ↔ reglas enteras', () => {
  it('ida y vuelta con los valores por defecto, en castellano (coma) y en inglés (punto)', () => {
    for (const [locale, decimal] of [['es', ','], ['en', '.']] as const) {
      const state = stateOf(DEFAULTS, decimal);
      expect(state.texts.fullIntegrityCheckCents).toBe(`1${decimal}80`);
      expect(state.texts.t1Bps).toBe('5');
      expect(state.texts.maxCampaignDays).toBe('60');
      expect(state.texts.preset2).toBe('2');
      const parsed = parseState(state, locale);
      expect(parsed.invalid).toEqual([]);
      expect(parsed.rules).toEqual(DEFAULTS);
    }
  });

  it('marca cada campo imposible, en el orden de la pantalla, y no devuelve reglas', () => {
    const state = stateOf(DEFAULTS, ',');
    state.texts.t1Bps = '4,567';
    state.texts.gatewayFixedCents = '-1';
    state.texts.maxCampaignDays = '76';
    state.texts.preset1 = '';
    const parsed = parseState(state, 'es');
    expect(parsed.rules).toBeNull();
    expect(parsed.invalid).toEqual(['t1Bps', 'preset1', 'gatewayFixedCents', 'maxCampaignDays']);
  });

  it('un porcentaje se escribe en %, se guarda en puntos básicos y los días solo admiten enteros', () => {
    expect(parseField('1,5', fieldDef('t1Bps'), 'es')).toBe(150);
    expect(parseField('15 %', fieldDef('sponsorFeeBps'), 'es')).toBe(1_500);
    expect(parseField('0,09', fieldDef('gatewayFixedCents'), 'es')).toBe(9);
    expect(parseField('1.234,50', fieldDef('exemptLimitCents'), 'es')).toBe(123_450);
    expect(parseField('60', fieldDef('maxCampaignDays'), 'es')).toBe(60);
    expect(parseField('60,5', fieldDef('maxCampaignDays'), 'es')).toBeNull();
    expect(parseField('0', fieldDef('maxCampaignDays'), 'es')).toBeNull();
    expect(parseField('71', fieldDef('creditPoolMaxDays'), 'es')).toBeNull();
    expect(parseField('abc', fieldDef('t1Bps'), 'es')).toBeNull();
    expect(NUMERIC_FIELDS.map((field) => field.key)).toHaveLength(new Set(NUMERIC_FIELDS.map((field) => field.key)).size);
  });

  it('un nivel de garantía por defecto fuera de los cuatro se recorta en vez de enviar una regla inválida', () => {
    const state = { ...stateOf(DEFAULTS, ','), defaultGuaranteeIdx: 9 };
    expect(parseState(state, 'es').rules?.defaultGuaranteeIdx).toBe(3);
  });
});

describe('medallas', () => {
  const tiers = (bronze: number, silver: number, gold: number) => [
    { key: 'bronze', campaignsRequired: bronze, grantCents: 50_000 },
    { key: 'silver', campaignsRequired: silver, grantCents: 100_000 },
    { key: 'gold', campaignsRequired: gold, grantCents: 200_000 }
  ];

  it('acepta niveles que piden más campañas cada vez', () => {
    expect(medalsSchema.safeParse(tiers(1, 2, 3)).success).toBe(true);
  });

  it.each([
    ['dos niveles que piden lo mismo', tiers(2, 2, 3)],
    ['un nivel que pide menos que el anterior', tiers(1, 3, 2)],
    ['0 campañas', tiers(0, 2, 3)],
    ['100 campañas', tiers(1, 2, 100)],
    ['una beca con decimales', [{ ...tiers(1, 2, 3)[0]!, grantCents: 500.5 }, ...tiers(1, 2, 3).slice(1)]],
    ['una beca negativa', [{ ...tiers(1, 2, 3)[0]!, grantCents: -1 }, ...tiers(1, 2, 3).slice(1)]],
    ['una medalla repetida', [tiers(1, 2, 3)[0]!, tiers(1, 2, 3)[0]!, tiers(1, 2, 3)[2]!]],
    ['solo dos medallas', tiers(1, 2, 3).slice(0, 2)]
  ])('rechaza %s', (_name, input) => {
    expect(medalsSchema.safeParse(input).success).toBe(false);
  });
});

describe('aceptar un aviso de precios y otras entradas de la consola', () => {
  it('el aviso se identifica por código, huella y fuente; no admite códigos inventados ni campos de más', () => {
    expect(pricingAcknowledgeTarget.safeParse({ code: 'HUCHA_FEE_BELOW_GATEWAY_COST', fingerprint: 'x=1' }).success).toBe(true);
    expect(pricingAcknowledgeTarget.safeParse({ code: 'SOURCE_NEGATIVE_MARGIN', fingerprint: 'x=1', source: 'huchaTopupFeeCents' }).success).toBe(true);
    expect(pricingAcknowledgeTarget.safeParse({ code: 'INVENTADO', fingerprint: 'x=1' }).success).toBe(false);
    expect(pricingAcknowledgeTarget.safeParse({ code: 'BRACKET_CLIFF', fingerprint: '' }).success).toBe(false);
    expect(pricingAcknowledgeTarget.safeParse({ code: 'BRACKET_CLIFF', fingerprint: 'x', extra: 1 }).success).toBe(false);
  });

  it('la nota de una decisión pide al menos 10 caracteres y rechaza datos personales (email, IBAN, DNI, teléfono)', () => {
    const note = (text: string) => resolveWithNoteSchema.safeParse({ alertId: 'abc', note: text }).success;
    expect(note('Hablado con Paycomet, esperamos su respuesta escrita.')).toBe(true);
    expect(note('corta')).toBe(false);
    expect(note('Escribir a ana.lopez@example.com para confirmarlo')).toBe(false);
    expect(note('Cuenta ES9121000418450200051332 de la entidad')).toBe(false);
    expect(note('Llamar al 612 345 678 mañana por la mañana')).toBe(false);
    expect(note('Fecha 12-05-2024 del acta caducada sin más datos')).toBe(true);
  });

  it('solo PAYOUT_BLOCKED y ACTIVITY_FUND_WINDOW se cierran con nota; el resto de alertas no', () => {
    expect(isNoteClosedAlertType('PAYOUT_BLOCKED')).toBe(true);
    expect(isNoteClosedAlertType('ACTIVITY_FUND_WINDOW')).toBe(true);
    for (const other of ['REFUND_STUCK', 'INVOICE_STUCK', 'JOB_FAILED', 'EMAIL_DELIVERY_FAILED']) expect(isNoteClosedAlertType(other)).toBe(false);
  });

  it('resolver un reparto: el código de autorización es corto y sin caracteres raros, o null si no se hizo', () => {
    const base = { kind: 'CAMPAIGN', splitId: 7 };
    expect(splitResolutionSchema.safeParse({ ...base, splitAuthCode: 'AUTH-123:ab.c' }).success).toBe(true);
    expect(splitResolutionSchema.safeParse({ ...base, splitAuthCode: null }).success).toBe(true);
    expect(splitResolutionSchema.safeParse({ ...base, splitAuthCode: '' }).success).toBe(false);
    expect(splitResolutionSchema.safeParse({ ...base, splitAuthCode: "x'; DROP TABLE" }).success).toBe(false);
    expect(splitResolutionSchema.safeParse({ ...base, splitId: 0, splitAuthCode: null }).success).toBe(false);
    expect(splitResolutionSchema.safeParse({ kind: 'OTHER', splitId: 1, splitAuthCode: null }).success).toBe(false);
  });

  it('el email directo exige asunto y mensaje con la longitud de una consulta y limpia el texto', () => {
    const ok = directEmailSchema.safeParse({ subject: '  Una novedad  ', message: 'Hola.\r\n\r\n\r\n\r\nHemos revisado vuestros documentos.' });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.subject).toBe('Una novedad');
      expect(ok.data.message).toBe('Hola.\n\nHemos revisado vuestros documentos.');
    }
    expect(directEmailSchema.safeParse({ subject: 'abc', message: 'Hola. Hemos revisado vuestros documentos.' }).success).toBe(false);
    expect(directEmailSchema.safeParse({ subject: 'Una novedad', message: 'muy corto' }).success).toBe(false);
    expect(directEmailSchema.safeParse({ subject: 'Una novedad', message: 'x'.repeat(2_001) }).success).toBe(false);
  });

  it('cerrar una rectificación: código de consulta válido y nota opcional sin datos personales', () => {
    expect(rectificationCloseSchema.safeParse({ ticketCode: 'TCK-7K3M9Q', outcome: 'COMPLETED' }).success).toBe(true);
    expect(rectificationCloseSchema.safeParse({ ticketCode: 'TCK-7K3M9Q', outcome: 'REJECTED', notes: 'No se pudo comprobar la identidad.' }).success).toBe(true);
    expect(rectificationCloseSchema.safeParse({ ticketCode: 'XXX', outcome: 'COMPLETED' }).success).toBe(false);
    expect(rectificationCloseSchema.safeParse({ ticketCode: 'TCK-7K3M9Q', outcome: 'COMPLETED', notes: 'nuevo email ana@example.com' }).success).toBe(false);
  });
});

describe('auditorías del Sprint 5.3: límites que el checkout y el Estudio pueden cobrar', () => {
  it('la aportación voluntaria no pasa de lo que el checkout cobra (50 €): ni el sugerido ni ningún nivel', () => {
    expect(globalRulesSchema.safeParse({ ...DEFAULTS, fullIntegrityCheckCents: 5_000, guaranteePresetsCents: [0, 100, 200, 5_000] }).success).toBe(true);
    for (const patch of [{ fullIntegrityCheckCents: 6_000 }, { guaranteePresetsCents: [0, 6_000, 8_000, 10_000] }]) {
      const result = globalRulesSchema.safeParse({ ...DEFAULTS, ...patch });
      expect(result.success).toBe(false);
      if (!result.success) expect(invalidRuleFields(result.error)).toEqual([Object.keys(patch)[0]]);
    }
  });

  it('el fijo por transacción de la pasarela no pasa de 100 €: con más, la meta del Estudio podría no caber en un entero de la base de datos', () => {
    expect(globalRulesSchema.safeParse({ ...DEFAULTS, gatewayFixedCents: 10_000 }).success).toBe(true);
    expect(globalRulesSchema.safeParse({ ...DEFAULTS, gatewayFixedCents: 10_001 }).success).toBe(false);
  });

  it('los campos del formulario usan los mismos límites que el servidor', () => {
    expect(fieldDef('fullIntegrityCheckCents').max).toBe(5_000);
    expect(fieldDef('preset3').max).toBe(5_000);
    expect(fieldDef('gatewayFixedCents').max).toBe(10_000);
    expect(parseField('60', fieldDef('fullIntegrityCheckCents'), 'es')).toBeNull();
    expect(parseField('50', fieldDef('preset1'), 'es')).toBe(5_000);
  });
});

describe('auditorías del Sprint 5.3: email directo sin enlaces y notas sin datos personales', () => {
  it.each([
    'Entra en https://korum-soporte.example/login para revisarlo',
    'Mira www.korum-soporte.example para más información',
    'Escríbeme a soporte@korum.example con tus datos',
    'Abre korum-soporte.com y revisa el panel de la entidad',
    'Visita //korum-soporte.example/entrar para comprobarlo',
    'Entra en KORUM-Soporte.ES para revisarlo todo',
    'Abre korum-ayuda.help para revisarlo todo',
    'Entra en pagos-korum.email y confirma los datos',
    'Mira korum.ai para más información sobre la entidad',
    'Entra en KORUM.SUPPORT/login para revisarlo todo'
  ])('rechaza «%s»', (text) => {
    expect(hasLinkOrAddress(text)).toBe(true);
    expect(directEmailSchema.safeParse({ subject: 'Revisión de documentos', message: text }).success).toBe(false);
    expect(directEmailSchema.safeParse({ subject: text.slice(0, 60), message: 'Hola. Hemos revisado todo y está en orden.' }).success).toBe(false);
  });

  it('un texto normal en castellano, catalán o inglés pasa: los puntos de las frases no son dominios', () => {
    for (const text of ['Hola. Hemos revisado la documentación de vuestra entidad. Todo está en orden. Un saludo.', 'Bon dia. Hem revisat la documentació. Tot en ordre.', 'Hello. We reviewed your documents. All good.']) {
      expect(hasLinkOrAddress(text)).toBe(false);
    }
  });

  it('la nota rechaza lo que un limpiador por nombre de campo no ve: DNI con guion o espacio, emails escritos con palabras', () => {
    const note = (text: string) => resolveWithNoteSchema.safeParse({ alertId: 'abc', note: text }).success;
    expect(note('Hablado con el padre, DNI 1234567-Z, para confirmarlo')).toBe(false);
    expect(note('Documento 12345678 Z de la persona que lo pidió')).toBe(false);
    expect(note('Su correo es juan punto perez arroba gmail punto com')).toBe(false);
    expect(note('Escribió a juan.perez punto com para decirlo')).toBe(false);
    expect(note('Paycomet repondrá el importe por escrito; lo sigue el promotor.')).toBe(true);
    expect(note('Revisado el cobro 1234567 de la liquidación con Paycomet')).toBe(true);
    // Una nota legítima con pedidos y fechas no se confunde con un DNI.
    expect(note('Pedido 20261113 a Paycomet hablado con soporte esta mañana')).toBe(true);
    expect(note('Ref 12345678 y luego otra gestión con Paycomet')).toBe(true);
    expect(note('DNI 12345678Z de la persona que lo pidió')).toBe(false);
  });

  it('corregir el nombre: código de consulta válido y un nombre de 2 a 120 caracteres limpio', () => {
    const ok = rectifyNameSchema.safeParse({ ticketCode: 'TCK-7K3M9Q', name: '  Ana   López García ' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.name).toBe('Ana López García');
    expect(rectifyNameSchema.safeParse({ ticketCode: 'TCK-7K3M9Q', name: 'A' }).success).toBe(false);
    expect(rectifyNameSchema.safeParse({ ticketCode: 'TCK-7K3M9Q', name: 'x'.repeat(121) }).success).toBe(false);
    expect(rectifyNameSchema.safeParse({ ticketCode: 'otro', name: 'Ana López' }).success).toBe(false);
    expect(rectifyNameSchema.safeParse({ ticketCode: 'TCK-7K3M9Q', name: 'Ana López', email: 'otro@example.com' }).success).toBe(false);
  });
});
