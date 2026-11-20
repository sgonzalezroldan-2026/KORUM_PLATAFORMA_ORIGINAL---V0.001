import { z } from 'zod';

/**
 * Borrador del Estudio de edición (Sprint 4.3, `sch-sub-studio` del prototipo): lo que escribe la entidad. Nunca incluye cifras calculadas (meta,
 * comisión, pasarela): el servidor las recalcula con el motor TCO y no se fía de lo que traiga el navegador. Los importes son céntimos enteros y los
 * porcentajes, puntos básicos (Regla 02 §1); la pantalla convierte lo que teclea la persona antes de enviarlo.
 */

export const STUDIO_FORMATS = ['BUDGET', 'TICKETING'] as const;
export type StudioFormat = (typeof STUDIO_FORMATS)[number];

/** Tipos de taquilla: un evento con aforo y fecha o una venta de vales (Sprint 5.14b). Los dos son `TICKETING` y comparten la categoría «Taquilla». */
export const TICKET_SUBTYPES = ['EVENT', 'VOUCHER'] as const;
export type StudioTicketSubtype = (typeof TICKET_SUBTYPES)[number];

/** Categoría fija de las campañas de taquilla (no es una mejora: el buzón de ideas la excluye). Siempre al 0 %, sin tramos. */
export const TICKETING_CATEGORY = 'Taquilla';

export type StudioVertical = 'SCHOOL' | 'SPORTS_CLUB' | 'CULTURAL';

/**
 * A quién beneficia la campaña, por vertical. El valor es lo que se guarda (como en la semilla del prototipo: «Todo el centro», «Infantil»…) y la
 * clave sale a `panel.studio.stages.<clave>`. La primera opción es la de toda la comunidad.
 */
export const STUDIO_STAGES: Record<StudioVertical, ReadonlyArray<{ value: string; key: string }>> = {
  SCHOOL: [
    { value: 'Todo el centro', key: 'all' },
    { value: 'Infantil', key: 'infantil' },
    { value: 'Primaria', key: 'primaria' },
    { value: 'ESO', key: 'eso' }
  ],
  SPORTS_CLUB: [
    { value: 'Todo el club', key: 'all' },
    { value: 'Equipos base', key: 'base' },
    { value: 'Equipos superiores', key: 'senior' }
  ],
  CULTURAL: [
    { value: 'Toda la entidad', key: 'all' },
    { value: 'Alumnado', key: 'students' },
    { value: 'Familias y socios', key: 'families' }
  ]
};

/** Premios del reto colectivo por curso (prototipo: `st-reward-preset`). `CUSTOM` abre el campo de texto propio. */
export const REWARD_PRESETS = ['cinema', 'games', 'noHomework'] as const;
export type RewardPreset = (typeof REWARD_PRESETS)[number];

export const STUDIO_LIMITS = {
  titleMax: 120,
  descriptionMax: 2000,
  rewardMax: 160,
  venueMax: 120,
  maxBudgetCents: 50_000_000,
  /** Reserva de mantenimiento, riesgos y contingencia: de 0 a 30 % (prototipo: `st-contingency-pct`). */
  maxContingencyBps: 3000,
  defaultContingencyBps: 1000,
  maxTicketPriceCents: 100_000,
  maxTicketMax: 20_000,
  minFamiliesPerCourse: 5,
  maxFamiliesPerCourse: 150,
  defaultFamiliesPerCourse: 35
} as const;

const cents = (max: number) => z.number().int().min(0).max(max);

/**
 * Texto que la entidad escribe y que acaba en la ficha pública, el cartel y las tarjetas de WhatsApp: sin caracteres de control ni de dirección de texto
 * (U+202E invierte lo que sigue) ni espacios de ancho cero, que sirven para disfrazar lo que se lee. La descripción admite saltos de línea.
 */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
const plainText = (max: number) => z.string().trim().max(max).refine((text) => !CONTROL.test(text), { message: 'CONTROL_CHARACTERS' });

export const studioDraftSchema = z
  .object({
    /** `null` si es una campaña nueva. */
    initiativeId: z.number().int().positive().max(2_147_483_647).nullable(),
    format: z.enum(STUDIO_FORMATS),
    /** Un título corto o vacío no se guarda (`TITLE_MISSING`, con su aviso junto al campo): por eso el esquema no lo exige. */
    title: plainText(STUDIO_LIMITS.titleMax),
    category: z.string().trim().max(80),
    /** Vacío mientras no se elige (una idea convertida nace sin él): lo exige publicar, no guardar. */
    stage: plainText(60),
    /** Último día en que se admiten aportaciones, `AAAA-MM-DD` en hora de España. */
    closesOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Un borrador se puede guardar sin descripción; publicar la exige. */
    description: plainText(STUDIO_LIMITS.descriptionMax),
    showPublicBreakdown: z.boolean(),
    plaqueEnabled: z.boolean(),
    rewardEnabled: z.boolean(),
    rewardText: plainText(STUDIO_LIMITS.rewardMax).nullable(),
    targetFamiliesPerCourse: z.number().int().min(STUDIO_LIMITS.minFamiliesPerCourse).max(STUDIO_LIMITS.maxFamiliesPerCourse),
    costMatCents: cents(STUDIO_LIMITS.maxBudgetCents),
    costInstCents: cents(STUDIO_LIMITS.maxBudgetCents),
    contingencyBps: cents(STUDIO_LIMITS.maxContingencyBps),
    ticketSubtype: z.enum(TICKET_SUBTYPES),
    ticketPriceCents: cents(STUDIO_LIMITS.maxTicketPriceCents),
    ticketMax: z.number().int().min(0).max(STUDIO_LIMITS.maxTicketMax),
    ticketFeeMode: z.enum(['ADD', 'INC']),
    ticketVenue: plainText(STUDIO_LIMITS.venueMax).nullable(),
    /**
     * Solo ventas de vales (Sprint 5.14b). Con valores por defecto: un borrador de presupuesto o de evento no los necesita y un cliente anterior que no los
     * envía sigue funcionando. `voucherCapped`: con tope (`ticketMax`) o sin él (`voucherTargetCount`, objetivo orientativo que no limita la venta).
     */
    voucherCapped: z.boolean().default(true),
    voucherTargetCount: z.number().int().min(0).max(STUDIO_LIMITS.maxTicketMax).default(0),
    /** Último día en que se pueden gastar los vales, `AAAA-MM-DD` en hora de España. */
    voucherValidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    /** Al agotarse el tope, seguir aportando «sin producto». El servidor lo apaga en un colegio con ánimo de lucro (decisión 65). */
    voucherNoProductEnabled: z.boolean().default(false)
  })
  .strict();

export type StudioDraft = z.infer<typeof studioDraftSchema>;

/** Valores de una campaña nueva en blanco. El presupuesto va a 0: KORUM nunca propone el precio de un proveedor. */
export function blankStudioDraft(format: StudioFormat, vertical: StudioVertical, defaultCloseOn: string, subtype: StudioTicketSubtype = 'EVENT'): StudioDraft {
  const stage = STUDIO_STAGES[vertical][0]?.value ?? '';
  const vouchers = format === 'TICKETING' && subtype === 'VOUCHER';
  return {
    initiativeId: null,
    format,
    title: '',
    category: format === 'TICKETING' ? TICKETING_CATEGORY : '',
    stage,
    closesOn: defaultCloseOn,
    description: '',
    showPublicBreakdown: true,
    // Una compra de vales no se apunta a un curso ni lleva placa (Sprint 5.14b).
    plaqueEnabled: !vouchers,
    rewardEnabled: !vouchers,
    rewardText: null,
    targetFamiliesPerCourse: STUDIO_LIMITS.defaultFamiliesPerCourse,
    costMatCents: 0,
    costInstCents: 0,
    contingencyBps: STUDIO_LIMITS.defaultContingencyBps,
    ticketSubtype: vouchers ? 'VOUCHER' : 'EVENT',
    ticketPriceCents: vouchers ? 200 : 500,
    ticketMax: 200,
    ticketFeeMode: 'ADD',
    ticketVenue: null,
    voucherCapped: true,
    voucherTargetCount: vouchers ? 200 : 0,
    voucherValidOn: vouchers ? defaultVoucherValidOn(defaultCloseOn) : null,
    voucherNoProductEnabled: false
  };
}

/** Meses que un vale puede seguir valiendo después del cierre de su venta, como mucho: frena una errata (2036 por 2026) sin limitar a la entidad (Sprint 5.14b). */
export const VOUCHER_VALIDITY_MAX_MONTHS = 12;
/** Días que dura como mucho una venta de vales (decisión 32), aunque el motor de reglas admita campañas más largas. */
export const VOUCHER_SALE_MAX_DAYS = 60;

const isoDay = (year: number, month: number, day: number) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/**
 * Validez por defecto de los vales: hasta el **inicio del curso siguiente**, el primer 1 de septiembre posterior al cierre de la venta (decisión del promotor del
 * 2026-11-20). La entidad la puede cambiar. `''` si la fecha de cierre no es válida.
 */
export function defaultVoucherValidOn(closesOn: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(closesOn);
  if (!match) return '';
  const [year, month] = [Number(match[1]), Number(match[2])];
  // El 1 de septiembre de ese año si el cierre es anterior (agosto o antes); si no, el del año siguiente. Un cierre el mismo 1 de septiembre ya es del curso nuevo.
  return isoDay(month <= 8 ? year : year + 1, 9, 1);
}

/** Último día que admite la validez: el cierre de la venta más `VOUCHER_VALIDITY_MAX_MONTHS` meses (el 31 de un mes corto se queda en su último día). */
export function latestVoucherValidOn(closesOn: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(closesOn);
  if (!match) return '';
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const total = year * 12 + (month - 1) + VOUCHER_VALIDITY_MAX_MONTHS;
  const [targetYear, targetMonth] = [Math.floor(total / 12), (total % 12) + 1];
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return isoDay(targetYear, targetMonth, Math.min(day, lastDay));
}

const MADRID = 'Europe/Madrid';

/** Minutos que Madrid adelanta a UTC en un instante (60 en invierno, 120 en verano). */
function madridOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: MADRID, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return (Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - at.getTime()) / 60_000;
}

/** Instante en que acaba el día `AAAA-MM-DD` en España (23:59): una campaña cierra al final del día elegido, no a medianoche UTC. Devuelve `null` si la fecha no existe. */
export function endOfDayInMadrid(isoDate: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const guess = new Date(Date.UTC(year, month - 1, day, 23, 59, 0));
  if (guess.getUTCFullYear() !== year || guess.getUTCMonth() !== month - 1 || guess.getUTCDate() !== day) return null;
  return new Date(guess.getTime() - madridOffsetMinutes(guess) * 60_000);
}

/** Instante en que empieza el día `AAAA-MM-DD` en España (00:00, con el horario de ese momento: un día de cambio de hora no se desplaza). `null` si la fecha no existe. */
export function startOfDayInMadrid(isoDate: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  if (guess.getUTCFullYear() !== year || guess.getUTCMonth() !== month - 1 || guess.getUTCDate() !== day) return null;
  // El desfase se mide en un instante cercano al de la hora local buscada (medianoche local = UTC − desfase): se prueba con el de la víspera y el del propio día.
  const offsetBefore = madridOffsetMinutes(new Date(guess.getTime() - 3 * 3_600_000));
  const candidate = new Date(guess.getTime() - offsetBefore * 60_000);
  return madridOffsetMinutes(candidate) === offsetBefore ? candidate : new Date(guess.getTime() - madridOffsetMinutes(candidate) * 60_000);
}

/** Día `AAAA-MM-DD` de un instante según la hora de España (el campo de fecha del Estudio). */
export function madridIsoDate(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: MADRID, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Cierre por defecto de una campaña nueva: `days` días después de hoy, en hora de España. */
export function defaultCloseOn(now: Date, days: number): string {
  return madridIsoDate(new Date(now.getTime() + days * 86_400_000));
}
