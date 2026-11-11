import { z } from 'zod';

/**
 * Borrador del Estudio de edición (Sprint 4.3, `sch-sub-studio` del prototipo): lo que escribe la entidad. Nunca incluye cifras calculadas (meta,
 * comisión, pasarela): el servidor las recalcula con el motor TCO y no se fía de lo que traiga el navegador. Los importes son céntimos enteros y los
 * porcentajes, puntos básicos (Regla 02 §1); la pantalla convierte lo que teclea la persona antes de enviarlo.
 */

export const STUDIO_FORMATS = ['BUDGET', 'TICKETING'] as const;
export type StudioFormat = (typeof STUDIO_FORMATS)[number];

/** Categoría fija de las campañas de taquilla y rifas (no es una mejora: el buzón de ideas la excluye). Siempre al 0 %, sin tramos. */
export const TICKETING_CATEGORY = 'Taquilla y Rifas';

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
  maxRafflePrizes: 100,
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
    ticketSubtype: z.enum(['EVENT', 'RAFFLE']),
    ticketPriceCents: cents(STUDIO_LIMITS.maxTicketPriceCents),
    ticketMax: z.number().int().min(0).max(STUDIO_LIMITS.maxTicketMax),
    ticketFeeMode: z.enum(['ADD', 'INC']),
    ticketVenue: plainText(STUDIO_LIMITS.venueMax).nullable(),
    rafflePrizeCount: z.number().int().min(1).max(STUDIO_LIMITS.maxRafflePrizes).nullable(),
    /** La entidad confirma que la rifa cumple la normativa de su comunidad autónoma (CUMPLIMIENTO §8). Queda en `AuditLog`. */
    raffleNoticeConfirmed: z.boolean()
  })
  .strict();

export type StudioDraft = z.infer<typeof studioDraftSchema>;

/** Valores de una campaña nueva en blanco. El presupuesto va a 0: KORUM nunca propone el precio de un proveedor. */
export function blankStudioDraft(format: StudioFormat, vertical: StudioVertical, defaultCloseOn: string): StudioDraft {
  const stage = STUDIO_STAGES[vertical][0]?.value ?? '';
  return {
    initiativeId: null,
    format,
    title: '',
    category: format === 'TICKETING' ? TICKETING_CATEGORY : '',
    stage,
    closesOn: defaultCloseOn,
    description: '',
    showPublicBreakdown: true,
    plaqueEnabled: true,
    rewardEnabled: true,
    rewardText: null,
    targetFamiliesPerCourse: STUDIO_LIMITS.defaultFamiliesPerCourse,
    costMatCents: 0,
    costInstCents: 0,
    contingencyBps: STUDIO_LIMITS.defaultContingencyBps,
    ticketSubtype: 'EVENT',
    ticketPriceCents: 500,
    ticketMax: 200,
    ticketFeeMode: 'ADD',
    ticketVenue: null,
    rafflePrizeCount: null,
    raffleNoticeConfirmed: false
  };
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
