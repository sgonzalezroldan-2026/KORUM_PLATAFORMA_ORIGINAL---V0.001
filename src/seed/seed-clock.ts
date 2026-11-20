import { z } from 'zod';
import { ACADEMIC_YEAR_START, academicYearFor } from '@/core/finance/academic-year';
import { quarterOf } from '@/core/ideas/idea-conversion';
import type { KorumPrismaClient } from '@/lib/prisma';
import type { InitiativeFundingPlan } from './funding-plan';
import type { KorumSeedData } from './seed-types';

/**
 * Reloj de la semilla (Sprint 5.7). `src/mocks/seed_data.json` está escrito para un «hoy» fijo, `SEED_REFERENCE_NOW`: sus campañas cierran
 * «dentro de N días» respecto a ese día. Al cargarla, todas sus fechas se desplazan el mismo número de **días enteros** para que ese «hoy» sea
 * el día de la carga, y las etiquetas de curso (`AAAA-AAAA`) el mismo número de **cursos enteros** para que el curso de la semilla sea el
 * curso en marcha. Así la demostración y las pruebas tienen siempre campañas recaudando, sin depender del calendario.
 *
 * - **Determinista:** los importes, el número de pagos y su orden no dependen de la fecha; los pagos se planifican con las fechas del JSON y
 *   después se desplazan (`shiftFundingPlans`), así que dos cargas de días distintos solo se diferencian en sus fechas.
 * - **Idempotente:** la primera carga guarda su reloj (`seed.clock`) y las siguientes lo reutilizan, aunque se vuelva a sembrar otro día
 *   (`resolveSeedClock`). Para fechas de hoy, `npm run db:reset`.
 * - **Aproximación conocida:** las fechas se desplazan por días y los cursos por cursos enteros, así que la fecha de publicación de una campaña
 *   no siempre cae dentro del curso de su etiqueta: la iniciativa 3 (curso anterior) aparece publicada dentro del curso en marcha casi todo el
 *   año (de finales de octubre al 21 de agosto), la 4 (dos cursos atrás) desde mayo, y las seis que recaudan llevan una fecha de publicación
 *   del curso anterior si se siembra entre el 22 de agosto y finales de septiembre. No cambia ningún importe ni ningún cupo (las reservas usan
 *   la etiqueta del curso): solo la fecha que se ve.
 */

/** «Hoy» para el que se escribieron las fechas de `seed_data.json`. Con este reloj la semilla es exactamente la del archivo. */
export const SEED_REFERENCE_NOW = new Date('2026-10-29T12:00:00.000Z');
/** Las campañas de la semilla se publicaron 55 días antes de su cierre (`Initiative.createdAt`), dentro del máximo de 60. */
export const SEED_PUBLISHED_DAYS_BEFORE_CLOSE = 55;
/** La iniciativa cuya fecha de publicación guarda el desplazamiento de una base ya sembrada. */
const ANCHOR_INITIATIVE_ID = 1;
const DAY_MS = 86_400_000;
const COURSE = /^(\d{4})-(\d{4})$/;
const DEMO_INVOICE_NUMBER = /^DEMO-\d{4}-/;

export interface SeedClock {
  /** Días enteros que se desplazan todas las fechas de la semilla (0 = las del archivo). */
  offsetDays: number;
  /** Cursos enteros que se desplazan las etiquetas `AAAA-AAAA` (0 = las del archivo). */
  courseOffset: number;
  /** «Hoy» de la semilla en esta carga: `SEED_REFERENCE_NOW` desplazado. Nunca es posterior al momento de la carga. */
  now: Date;
  /** Curso en marcha de la semilla (`Organization.quotaPeriod`). */
  academicYear: string;
}

export class SeedClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedClockError';
  }
}

const courseStartYear = (course: string): number => {
  const match = COURSE.exec(course);
  if (!match || Number(match[2]) !== Number(match[1]) + 1) throw new SeedClockError(`«${course}» no es un curso AAAA-AAAA`);
  return Number(match[1]);
};

/** Desplaza un curso `AAAA-AAAA` un número entero de cursos. */
export function shiftCourse(course: string, courseOffset: number): string {
  const start = courseStartYear(course) + courseOffset;
  return `${start}-${start + 1}`;
}

/** Curso en marcha para el que se escribió la semilla (el de `SEED_REFERENCE_NOW`). */
const REFERENCE_COURSE = academicYearFor(SEED_REFERENCE_NOW);

/** Reloj con un desplazamiento dado en días y en cursos. */
export function seedClockFromOffsets(offsetDays: number, courseOffset: number): SeedClock {
  if (!Number.isSafeInteger(offsetDays)) throw new SeedClockError(`El desplazamiento de la semilla debe ser un número entero de días (recibido ${offsetDays})`);
  if (!Number.isSafeInteger(courseOffset)) throw new SeedClockError(`El desplazamiento de cursos de la semilla debe ser un número entero (recibido ${courseOffset})`);
  return { offsetDays, courseOffset, now: new Date(SEED_REFERENCE_NOW.getTime() + offsetDays * DAY_MS), academicYear: shiftCourse(REFERENCE_COURSE, courseOffset) };
}

/**
 * Reloj de una carga nueva: los días enteros transcurridos desde la referencia (el «hoy» de la semilla nunca supera a `loadedAt`) y los cursos
 * que hay entre el de la referencia y el del momento de la carga, de modo que `Organization.quotaPeriod` es `academicYearFor(loadedAt)` y la
 * renovación anual de cupos no la toca.
 */
export function seedClockFor(loadedAt: Date): SeedClock {
  if (Number.isNaN(loadedAt.getTime())) throw new SeedClockError('La fecha de carga de la semilla no es válida');
  const offsetDays = Math.floor((loadedAt.getTime() - SEED_REFERENCE_NOW.getTime()) / DAY_MS);
  return seedClockFromOffsets(offsetDays, courseStartYear(academicYearFor(loadedAt)) - courseStartYear(REFERENCE_COURSE));
}

export const shiftDate = (clock: Pick<SeedClock, 'offsetDays'>, date: Date): Date => new Date(date.getTime() + clock.offsetDays * DAY_MS);
const shiftIso = (clock: Pick<SeedClock, 'offsetDays'>, iso: string): string => shiftDate(clock, new Date(iso)).toISOString();

/** Fecha de publicación con la que la semilla crea una iniciativa (también la que guarda el desplazamiento). */
export const seededPublicationDate = (closesAt: Date): Date => new Date(closesAt.getTime() - SEED_PUBLISHED_DAYS_BEFORE_CLOSE * DAY_MS);

/**
 * Copia de la semilla con sus fechas y cursos desplazados. Con `offsetDays = 0` y `courseOffset = 0` devuelve exactamente el archivo (lo
 * comprueban las pruebas). El trimestre de cada iniciativa se recalcula con su cierre, como hace la aplicación (`quarterOf`), y el número de
 * las facturas de demostración lleva el año de su emisión (`DEMO-AAAA-NNNN`).
 */
export function shiftSeedData(seed: KorumSeedData, clock: Pick<SeedClock, 'offsetDays' | 'courseOffset'>): KorumSeedData {
  const shifted = structuredClone(seed);
  for (const initiative of shifted.initiatives) {
    initiative.closesAt = shiftIso(clock, initiative.closesAt);
    // La validez de una venta de vales se mueve con su cierre: nunca caduca antes de que acabe la venta (Sprint 5.14b).
    if (initiative.voucherValidUntil) initiative.voucherValidUntil = shiftIso(clock, initiative.voucherValidUntil);
    initiative.academicYear = shiftCourse(initiative.academicYear, clock.courseOffset);
    initiative.quarter = quarterOf(new Date(initiative.closesAt));
  }
  for (const sponsor of shifted.sponsors) sponsor.expiresAt = shiftIso(clock, sponsor.expiresAt);
  for (const idea of shifted.ideas) {
    idea.expiresAt = shiftIso(clock, idea.expiresAt);
    for (const message of idea.messages) {
      if (message.createdAt) message.createdAt = shiftIso(clock, message.createdAt);
    }
  }
  for (const invoice of shifted.invoices) {
    const original = invoice.invoiceNumber;
    invoice.issuedAt = shiftIso(clock, invoice.issuedAt);
    if (DEMO_INVOICE_NUMBER.test(original)) {
      invoice.invoiceNumber = original.replace(DEMO_INVOICE_NUMBER, `DEMO-${new Date(invoice.issuedAt).getUTCFullYear()}-`);
      invoice.verifactuQrUrl = invoice.verifactuQrUrl.replace(`numserie=${original}`, `numserie=${invoice.invoiceNumber}`);
    }
  }
  for (const ticket of shifted.supportTickets) ticket.createdAt = shiftIso(clock, ticket.createdAt);
  return shifted;
}

/** Desplaza las fechas de los pagos planificados con las fechas del archivo. Los importes y las claves no cambian. */
export function shiftFundingPlans(plans: InitiativeFundingPlan[], clock: Pick<SeedClock, 'offsetDays'>): InitiativeFundingPlan[] {
  return plans.map((plan) => ({
    ...plan,
    payments: plan.payments.map((payment) => ({ ...payment, createdAt: shiftDate(clock, payment.createdAt) })),
    matching: plan.matching.map((release) => ({ ...release, createdAt: shiftDate(clock, release.createdAt) })),
    poolPayins: plan.poolPayins.map((payin) => ({ ...payin, paidAt: shiftDate(clock, payin.paidAt) })),
    firstPayinAt: plan.firstPayinAt ? shiftDate(clock, plan.firstPayinAt) : null
  }));
}

/** Ajuste interno (no se edita en la consola, como la marca de la última conciliación) donde la primera carga guarda su reloj. */
export const SEED_CLOCK_SETTING = 'seed.clock';

const storedClockSchema = z.object({ offsetDays: z.number().int(), courseOffset: z.number().int() });

/** Desplazamiento que deja la iniciativa 1 si la sembró este reloj (fecha de publicación y curso), o `null` si sus datos no son de la semilla. */
function anchorOffsets(anchor: KorumSeedData['initiatives'][number], stored: { createdAt: Date; academicYear: string }): { offsetDays: number; courseOffset: number } | null {
  const difference = stored.createdAt.getTime() - seededPublicationDate(new Date(anchor.closesAt)).getTime();
  if (difference % DAY_MS !== 0 || !COURSE.test(stored.academicYear)) return null;
  return { offsetDays: difference / DAY_MS, courseOffset: courseStartYear(stored.academicYear) - courseStartYear(anchor.academicYear) };
}

const reseedHint = 'reiníciala con npm run db:reset (solo en bases locales o de demostración)';

/**
 * Reloj de una carga. La primera carga lo guarda en `seed.clock` antes de escribir nada más (`persistSeedClock`); las siguientes lo leen de
 * ahí, aunque se siembre otro día, y lo contrastan con la iniciativa 1 (fecha de publicación y curso, que la aplicación no cambia): si no
 * coinciden, la base tiene fechas de otra carga o de otra versión de la semilla y se pide reiniciarla en vez de mezclar fechas. Una base
 * sembrada antes del Sprint 5.7 no tiene el ajuste: su reloj se deduce de la iniciativa 1 (desplazamiento 0). Sin semilla, el del momento de la carga.
 */
export async function resolveSeedClock(db: KorumPrismaClient, seed: KorumSeedData, loadedAt: Date): Promise<{ clock: SeedClock; reused: boolean }> {
  const anchor = seed.initiatives.find((initiative) => initiative.id === ANCHOR_INITIATIVE_ID);
  if (!anchor) throw new SeedClockError(`La semilla no tiene la iniciativa ${ANCHOR_INITIATIVE_ID}, que guarda su desplazamiento de fechas`);
  const [setting, stored] = await Promise.all([
    db.platformSetting.findUnique({ where: { key: SEED_CLOCK_SETTING }, select: { valueJson: true } }),
    db.initiative.findUnique({ where: { id: ANCHOR_INITIATIVE_ID }, select: { createdAt: true, academicYear: true } })
  ]);
  const fromAnchor = stored ? anchorOffsets(anchor, stored) : null;
  if (stored && !fromAnchor) {
    throw new SeedClockError(`La iniciativa ${ANCHOR_INITIATIVE_ID} de esta base no tiene las fechas de la semilla (publicada el ${stored.createdAt.toISOString()}, curso ${stored.academicYear}): ${reseedHint}.`);
  }
  if (setting) {
    const parsed = storedClockSchema.safeParse(setting.valueJson);
    if (!parsed.success) throw new SeedClockError(`El ajuste ${SEED_CLOCK_SETTING} de esta base no es válido: ${reseedHint}.`);
    if (fromAnchor && (fromAnchor.offsetDays !== parsed.data.offsetDays || fromAnchor.courseOffset !== parsed.data.courseOffset)) {
      throw new SeedClockError(
        `Las fechas de la iniciativa ${ANCHOR_INITIATIVE_ID} (${fromAnchor.offsetDays} días, ${fromAnchor.courseOffset} cursos) no son las de la carga guardada (${parsed.data.offsetDays} días, ${parsed.data.courseOffset} cursos): ${reseedHint}.`
      );
    }
    return { clock: seedClockFromOffsets(parsed.data.offsetDays, parsed.data.courseOffset), reused: true };
  }
  if (fromAnchor) return { clock: seedClockFromOffsets(fromAnchor.offsetDays, fromAnchor.courseOffset), reused: true };
  return { clock: seedClockFor(loadedAt), reused: false };
}

/** Guarda el reloj de la carga: lo primero que se siembra, para que una carga cortada a medias se repita con las mismas fechas. No pisa uno guardado. */
export async function persistSeedClock(db: KorumPrismaClient, clock: SeedClock): Promise<void> {
  await db.platformSetting.upsert({
    where: { key: SEED_CLOCK_SETTING },
    create: { key: SEED_CLOCK_SETTING, valueJson: { offsetDays: clock.offsetDays, courseOffset: clock.courseOffset, seedDay: seedDay(clock) } },
    update: {}
  });
}

/**
 * Un instante dentro del curso de la semilla y no posterior a su carga: el «hoy» de la semilla o, si aún cae en el curso anterior (carga en
 * las primeras horas del 22 de agosto), el comienzo del curso. Sirve para reservar cupos de la semilla sin renovar su curso.
 */
export function seedCourseInstant(clock: SeedClock): Date {
  const courseStart = Date.UTC(courseStartYear(clock.academicYear), ACADEMIC_YEAR_START.month - 1, ACADEMIC_YEAR_START.day);
  return new Date(Math.max(clock.now.getTime(), courseStart));
}

/** Fecha corta (`AAAA-MM-DD`) del «hoy» de una carga, para los mensajes. */
export const seedDay = (clock: Pick<SeedClock, 'now'>): string => clock.now.toISOString().slice(0, 10);
