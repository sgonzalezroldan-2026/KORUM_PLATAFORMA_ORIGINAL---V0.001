import { z } from 'zod';
import { safeDisplayText } from '@/core/security/safe-text';

/**
 * Reglas de la ficha 360º de una entidad (Sprint 5.2). Funciones puras: el formulario las usa para avisar campo a campo y el servidor las vuelve a
 * aplicar antes de guardar. Ninguna regla de precios bloquea el guardado por «perder dinero» (eso lo avisa la salud de precios), pero **sí se rechazan
 * los datos imposibles** (decimales, negativos, no numéricos, fuera de rango): lo que entra aquí son siempre enteros (céntimos y puntos básicos).
 */

// --- Tarifas individuales ------------------------------------------------------------------------------------------------------------------

const cents = (max: number) => z.number().int().min(0).max(max);
const bps = z.number().int().min(0).max(10_000);

export const TARIFF_LIMITS = {
  exemptLimitCents: 100_000_000,
  fullIntegrityCheckCents: 100_000,
  ticketFeeFixedCents: 100_000,
  maintPerInitCents: 10_000_000,
  maintAnnualCapCents: 100_000_000
} as const;

/** Tarifas propias de una entidad: todos los campos son obligatorios y enteros. Con `customRules` apagado se aplican las globales y no se piden. */
export const customTariffSchema = z
  .object({
    customRules: z.literal(true),
    exemptLimitCents: cents(TARIFF_LIMITS.exemptLimitCents),
    t1Bps: bps,
    t2Bps: bps,
    t3Bps: bps,
    sponsorFeeBps: bps,
    fullIntegrityCheckCents: cents(TARIFF_LIMITS.fullIntegrityCheckCents),
    ticketFeeFixedCents: cents(TARIFF_LIMITS.ticketFeeFixedCents),
    ticketFeeBps: bps,
    maintActive: z.boolean(),
    maintPerInitCents: cents(TARIFF_LIMITS.maintPerInitCents),
    maintAnnualCapCents: cents(TARIFF_LIMITS.maintAnnualCapCents)
  })
  .strict();

export const tariffSchema = z.discriminatedUnion('customRules', [customTariffSchema, z.object({ customRules: z.literal(false) }).strict()]);
export type TariffInput = z.infer<typeof tariffSchema>;
export type CustomTariff = z.infer<typeof customTariffSchema>;

/** Los once valores de una tarifa (los mismos campos en `Organization` y en `GlobalConfig`). */
export type TariffValues = Omit<CustomTariff, 'customRules'>;

/** Copia solo los campos de la tarifa de cualquier objeto que los tenga (una entidad, la configuración global o un formulario). */
export function pickTariffValues(source: TariffValues): TariffValues {
  return {
    exemptLimitCents: source.exemptLimitCents,
    t1Bps: source.t1Bps,
    t2Bps: source.t2Bps,
    t3Bps: source.t3Bps,
    sponsorFeeBps: source.sponsorFeeBps,
    fullIntegrityCheckCents: source.fullIntegrityCheckCents,
    ticketFeeFixedCents: source.ticketFeeFixedCents,
    ticketFeeBps: source.ticketFeeBps,
    maintActive: source.maintActive,
    maintPerInitCents: source.maintPerInitCents,
    maintAnnualCapCents: source.maintAnnualCapCents
  };
}

/** Campos que no pasan el esquema, para marcarlos en el formulario (solo la ruta del campo, nunca su valor). */
export function invalidTariffFields(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => String(issue.path[0] ?? 'form')))];
}

/**
 * Lo que queda del cupo exento al cambiar el límite anual: `límite nuevo − lo ya gastado` (lo gastado no cambia). `null` si el límite nuevo no cubre lo ya gastado:
 * recortarlo a 0 perdería lo gastado y, al volver a subir el límite, el cupo reaparecería.
 */
export function shiftedExemptRemaining(oldLimitCents: number, newLimitCents: number, remainingCents: number): number | null {
  const usedCents = Math.max(0, oldLimitCents - remainingCents);
  // Un límite por debajo de lo ya gastado se rechaza: recortarlo a 0 perdería lo gastado y, al volver a subir el límite, el cupo reaparecería (auditoría financiera, I4).
  return newLimitCents < usedCents ? null : newLimitCents - usedCents;
}

// --- Categorías ---------------------------------------------------------------------------------------------------------------------------

export const CATEGORY_RULES = ['EXEMPT', 'BRACKETS'] as const;
const plain = (min: number, max: number) =>
  z
    .string()
    .transform((value) => safeDisplayText(value, max + 1))
    .pipe(z.string().min(min).max(max));

export const categorySchema = z.object({ name: plain(2, 60), icon: plain(1, 8).default('🌟'), rule: z.enum(CATEGORY_RULES) }).strict();
export const categoryRuleSchema = z.object({ name: plain(2, 60), rule: z.enum(CATEGORY_RULES) }).strict();
export type CategoryInput = z.infer<typeof categorySchema>;

// --- Revisión del KYB ---------------------------------------------------------------------------------------------------------------------

export const KYB_NOTE_MAX = 600;

/**
 * Dato personal que no debe ir en la nota que lee la entidad: email, IBAN, DNI/NIE o una serie de 9 cifras o más (un teléfono, una cuenta). Una fecha como
 * `12-05-2024` (8 cifras) o un año no cuentan: una nota sobre un acta caducada tiene que poder decir cuándo.
 */
const PERSONAL_DATA = [/[^\s@]+@[^\s@]+/, /\b[A-Z]{2}\d{2}[A-Z0-9 ]{10,}/i, /\b[XYZ]?\d{7,8}[A-Z]\b/i, /(?:\d[ .-]?){9,}/];

export function noteHasPersonalData(note: string): boolean {
  return PERSONAL_DATA.some((pattern) => pattern.test(note));
}

const note = z
  .string()
  .transform((value) => safeDisplayText(value, KYB_NOTE_MAX + 1))
  .pipe(z.string().min(10).max(KYB_NOTE_MAX))
  .refine((value) => !noteHasPersonalData(value), { message: 'PERSONAL_DATA' });

/** Identificador de la cuenta destino en Paycomet (Split Id): solo caracteres de un identificador. Opcional al verificar. */
const splitId = z
  .string()
  .trim()
  .min(3)
  .max(80)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const kybReviewSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('VERIFIED'), ley49Accredited: z.boolean(), paycometSplitId: splitId.optional() }).strict(),
  z.object({ decision: z.literal('REJECTED'), note, releaseCif: z.boolean() }).strict()
]);
export type KybReviewInput = z.infer<typeof kybReviewSchema>;

/** Qué se dice de la Ley 49/2002 en el email de la entidad. */
export type Ley49Outcome = 'NOT_DECLARED' | 'VERIFIED' | 'NOT_ACCREDITED';

export function ley49Outcome(declared: boolean, accredited: boolean): Ley49Outcome {
  if (!declared) return 'NOT_DECLARED';
  return accredited ? 'VERIFIED' : 'NOT_ACCREDITED';
}
