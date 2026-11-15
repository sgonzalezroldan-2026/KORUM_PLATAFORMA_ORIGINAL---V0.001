import { describe, expect, it } from 'vitest';
import { spanishFiscalYear } from '@/core/checkout/checkout-rules';
import { academicYearFor } from '@/core/finance/academic-year';
import { quarterOf } from '@/core/ideas/idea-conversion';
import type { KorumPrismaClient } from '@/lib/prisma';
import { planAllFunding } from '@/seed/funding-plan';
import { createRandom } from '@/seed/random';
import {
  resolveSeedClock,
  SEED_PUBLISHED_DAYS_BEFORE_CLOSE,
  SEED_REFERENCE_NOW,
  SeedClockError,
  seedClockFor,
  seedClockFromOffsets,
  seedCourseInstant,
  seededPublicationDate,
  shiftCourse,
  shiftFundingPlans,
  shiftSeedData
} from '@/seed/seed-clock';
import { contributionRow } from '@/seed/seed-funding';
import { loadSeedData } from '@/seed/seed-types';

/**
 * QA-C04 · Sprint 5.7: las fechas de la semilla se calculan respecto al día de la carga. Ninguna de estas pruebas usa el reloj real: cada
 * una fija su «día de la carga», también muy lejos de hoy, para que la semilla siga siendo coherente cualquier día que se ejecute.
 */

const DAY = 86_400_000;
const reference = loadSeedData();
const referencePlans = planAllFunding(reference);
const time = (iso: string) => new Date(iso).getTime();

/** Milisegundos del «hoy» de la referencia a cada fecha: la semilla desplazada los conserva exactamente (enteros, sin coma flotante). */
const distanceFromReference = (iso: string) => time(iso) - SEED_REFERENCE_NOW.getTime();

/** Días de carga repartidos en seis años (incluidos los cambios de año natural y de curso), con una semilla de azar fija. */
function loadingDays(): Date[] {
  const random = createRandom(57);
  const days = [SEED_REFERENCE_NOW, new Date('2026-11-15T09:30:00Z'), new Date('2027-01-14T23:59:59Z'), new Date('2027-08-21T23:00:00Z'), new Date('2027-08-22T00:00:00Z'), new Date('2028-02-29T12:00:00Z')];
  for (let i = 0; i < 200; i += 1) days.push(new Date(SEED_REFERENCE_NOW.getTime() - 90 * DAY + Math.floor(random() * 6 * 365 * DAY)));
  return days;
}

describe('seedClockFor · el «hoy» de la semilla es el día de la carga', () => {
  it('con el «hoy» de referencia la semilla es exactamente la del archivo', () => {
    const clock = seedClockFor(SEED_REFERENCE_NOW);
    expect(clock).toEqual({ offsetDays: 0, courseOffset: 0, now: SEED_REFERENCE_NOW, academicYear: '2026-2027' });
    expect(shiftSeedData(reference, clock)).toEqual(reference);
    expect(shiftFundingPlans(referencePlans, clock)).toEqual(referencePlans);
    // El trimestre que se recalcula al desplazar es el que trae el archivo.
    for (const initiative of reference.initiatives) expect(quarterOf(new Date(initiative.closesAt)), `iniciativa ${initiative.id}`).toBe(initiative.quarter);
  });

  it.each(loadingDays().map((day) => [day.toISOString()]))('carga del %s: días enteros, nunca en el futuro y con el curso en marcha', (iso) => {
    const loadedAt = new Date(iso);
    const clock = seedClockFor(loadedAt);
    expect(Number.isSafeInteger(clock.offsetDays)).toBe(true);
    expect(clock.now.getTime()).toBeLessThanOrEqual(loadedAt.getTime());
    expect(loadedAt.getTime() - clock.now.getTime()).toBeLessThan(DAY);
    expect(clock.academicYear).toBe(academicYearFor(loadedAt));
  });

  it('rechaza una fecha de carga que no es una fecha', () => {
    expect(() => seedClockFor(new Date('no es una fecha'))).toThrow(SeedClockError);
    expect(() => seedClockFromOffsets(1.5, 0)).toThrow(SeedClockError);
    expect(() => seedClockFromOffsets(1, 0.5)).toThrow(SeedClockError);
  });
});

describe('shiftSeedData · fechas, cursos, trimestres y facturas desplazados', () => {
  it.each(loadingDays().map((day) => [day.toISOString()]))('carga del %s: las campañas recaudando cierran en los mismos días que en el archivo', (iso) => {
    const loadedAt = new Date(iso);
    const clock = seedClockFor(loadedAt);
    const seed = shiftSeedData(reference, clock);

    seed.initiatives.forEach((initiative, index) => {
      const original = reference.initiatives[index]!;
      expect(distanceFromReference(initiative.closesAt) - clock.offsetDays * DAY).toBe(distanceFromReference(original.closesAt));
      expect(initiative.academicYear).toBe(shiftCourse(original.academicYear, clock.courseOffset));
      expect(initiative.quarter).toBe(quarterOf(new Date(initiative.closesAt)));
      // Nada más cambia: importes, estados y textos son los del archivo.
      expect({ ...initiative, closesAt: original.closesAt, academicYear: original.academicYear, quarter: original.quarter }).toEqual(original);
      if (original.status === 'FUNDRAISING') {
        const daysLeft = (time(initiative.closesAt) - loadedAt.getTime()) / DAY;
        expect(daysLeft, `iniciativa ${initiative.id}`).toBeGreaterThan(distanceFromReference(original.closesAt) / DAY - 1);
        expect(daysLeft, `iniciativa ${initiative.id}`).toBeLessThanOrEqual(60);
        expect(seededPublicationDate(new Date(initiative.closesAt)).getTime()).toBeLessThan(loadedAt.getTime());
      }
    });
    // El curso en marcha de la semilla es el de la carga: las campañas del archivo «de este curso» lo son el día que se carga.
    const current = seed.initiatives.filter((initiative, index) => reference.initiatives[index]!.academicYear === '2026-2027');
    expect(current.length).toBeGreaterThan(0);
    for (const initiative of current) expect(initiative.academicYear).toBe(clock.academicYear);

    seed.sponsors.forEach((sponsor, index) => expect(distanceFromReference(sponsor.expiresAt) - clock.offsetDays * DAY).toBe(distanceFromReference(reference.sponsors[index]!.expiresAt)));
    seed.ideas.forEach((idea, index) => expect(distanceFromReference(idea.expiresAt) - clock.offsetDays * DAY).toBe(distanceFromReference(reference.ideas[index]!.expiresAt)));
    seed.supportTickets.forEach((ticket, index) => expect(distanceFromReference(ticket.createdAt) - clock.offsetDays * DAY).toBe(distanceFromReference(reference.supportTickets[index]!.createdAt)));
    seed.invoices.forEach((invoice, index) => {
      const original = reference.invoices[index]!;
      expect(distanceFromReference(invoice.issuedAt) - clock.offsetDays * DAY).toBe(distanceFromReference(original.issuedAt));
      expect(invoice.invoiceNumber).toBe(`DEMO-${new Date(invoice.issuedAt).getUTCFullYear()}-${original.invoiceNumber.slice(-4)}`);
      expect(invoice.verifactuQrUrl).toBe(original.verifactuQrUrl.replace(original.invoiceNumber, invoice.invoiceNumber));
      expect(invoice.verifactuHash).toBe(original.verifactuHash);
    });
    expect(new Set(seed.invoices.map((invoice) => invoice.invoiceNumber)).size).toBe(seed.invoices.length);
  });

  it('no modifica la semilla del archivo', () => {
    const before = JSON.stringify(reference);
    shiftSeedData(reference, seedClockFor(new Date('2030-05-05T10:00:00Z')));
    expect(JSON.stringify(reference)).toBe(before);
  });

  it('shiftCourse desplaza cursos enteros y rechaza lo que no es un curso', () => {
    expect(shiftCourse('2026-2027', 0)).toBe('2026-2027');
    expect(shiftCourse('2024-2025', 3)).toBe('2027-2028');
    expect(shiftCourse('2026-2027', -1)).toBe('2025-2026');
    expect(() => shiftCourse('2026-2028', 0)).toThrow(SeedClockError);
    expect(() => shiftCourse('2026', 0)).toThrow(SeedClockError);
  });
});

describe('shiftFundingPlans · el reparto es el mismo cualquier día', () => {
  it.each([['2026-11-15T09:30:00Z'], ['2027-01-14T12:00:00Z'], ['2027-09-01T08:00:00Z'], ['2031-03-03T03:03:03Z']])('carga del %s: mismos pagos e importes, solo cambian las fechas y todas son anteriores a la carga', (iso) => {
    const loadedAt = new Date(iso);
    const clock = seedClockFor(loadedAt);
    const plans = shiftFundingPlans(planAllFunding(reference), clock);
    const strip = (value: unknown) => JSON.stringify(value, (key, field: unknown) => (['createdAt', 'paidAt', 'firstPayinAt'].includes(key) ? null : field));
    expect(strip(plans)).toBe(strip(referencePlans));

    plans.forEach((plan, index) => {
      const original = referencePlans[index]!;
      plan.payments.forEach((payment, position) => expect(payment.createdAt.getTime() - original.payments[position]!.createdAt.getTime()).toBe(clock.offsetDays * DAY));
      plan.matching.forEach((release, position) => expect(release.createdAt.getTime() - original.matching[position]!.createdAt.getTime()).toBe(clock.offsetDays * DAY));
      plan.poolPayins.forEach((payin, position) => expect(payin.paidAt.getTime() - original.poolPayins[position]!.paidAt.getTime()).toBe(clock.offsetDays * DAY));
      const payins = [...plan.payments.map((payment) => payment.createdAt), ...plan.poolPayins.map((payin) => payin.paidAt)].map((date) => date.getTime());
      const times = [...payins, ...plan.matching.map((release) => release.createdAt.getTime())];
      expect(Math.max(...times), `iniciativa ${plan.initiativeId}`).toBeLessThanOrEqual(loadedAt.getTime());
      expect(plan.firstPayinAt!.getTime()).toBe(Math.min(...payins));
    });
  });
});

describe('resolveSeedClock · volver a sembrar otro día conserva las fechas de la base', () => {
  const anchor = reference.initiatives.find((initiative) => initiative.id === 1)!;
  type AnchorRow = { createdAt: Date; academicYear: string } | null;
  const fakeDb = (row: AnchorRow, setting: unknown = null) =>
    ({
      initiative: { findUnique: async () => row },
      platformSetting: { findUnique: async () => (setting === null ? null : { valueJson: setting }) }
    }) as unknown as KorumPrismaClient;
  /** La iniciativa 1 tal como la deja una carga con este reloj. */
  const anchorRow = (clock: ReturnType<typeof seedClockFor>) => {
    const seeded = shiftSeedData(reference, clock).initiatives.find((initiative) => initiative.id === 1)!;
    return { createdAt: seededPublicationDate(new Date(seeded.closesAt)), academicYear: seeded.academicYear };
  };
  const first = seedClockFor(new Date('2026-11-15T09:30:00Z'));
  const saved = { offsetDays: first.offsetDays, courseOffset: first.courseOffset, seedDay: '2026-11-14' };

  it('una base vacía toma el día de la carga', async () => {
    const loadedAt = new Date('2027-03-03T15:00:00Z');
    expect(await resolveSeedClock(fakeDb(null), reference, loadedAt)).toEqual({ clock: seedClockFor(loadedAt), reused: false });
  });

  it('una base ya sembrada conserva el reloj guardado por la primera carga, aunque se vuelva a sembrar mucho después', async () => {
    expect(await resolveSeedClock(fakeDb(anchorRow(first), saved), reference, new Date('2028-01-20T10:00:00Z'))).toEqual({ clock: first, reused: true });
  });

  it('una carga cortada antes de las campañas se repite otro día con el reloj guardado, no con el del día nuevo', async () => {
    expect(await resolveSeedClock(fakeDb(null, saved), reference, new Date('2027-09-30T10:00:00Z'))).toEqual({ clock: first, reused: true });
  });

  it('una base de antes del Sprint 5.7 (sin reloj guardado, fechas fijas del archivo) se reconoce como desplazamiento 0; sin ajuste, se deduce de la iniciativa 1', async () => {
    const legacy = { createdAt: new Date(time(anchor.closesAt) - SEED_PUBLISHED_DAYS_BEFORE_CLOSE * DAY), academicYear: anchor.academicYear };
    expect(await resolveSeedClock(fakeDb(legacy), reference, new Date('2027-05-05T10:00:00Z'))).toEqual({ clock: seedClockFromOffsets(0, 0), reused: true });
    expect(await resolveSeedClock(fakeDb(anchorRow(first)), reference, new Date('2027-05-05T10:00:00Z'))).toEqual({ clock: first, reused: true });
  });

  it('si la iniciativa 1 no es de la semilla o no casa con el reloj guardado, pide reiniciar la base en vez de mezclar fechas', async () => {
    const odd = { createdAt: new Date(time(anchor.closesAt) - SEED_PUBLISHED_DAYS_BEFORE_CLOSE * DAY + 3_600_000), academicYear: anchor.academicYear };
    await expect(resolveSeedClock(fakeDb(odd), reference, new Date())).rejects.toThrow(/npm run db:reset/);
    await expect(resolveSeedClock(fakeDb({ createdAt: new Date(time(anchor.closesAt) - SEED_PUBLISHED_DAYS_BEFORE_CLOSE * DAY), academicYear: 'curso' }), reference, new Date())).rejects.toThrow(SeedClockError);
    // Una versión futura del archivo que moviera el cierre de la iniciativa 1 días enteros: el reloj deducido ya no es el guardado.
    const other = seedClockFor(new Date('2026-11-20T09:30:00Z'));
    await expect(resolveSeedClock(fakeDb(anchorRow(other), saved), reference, new Date())).rejects.toThrow(/no son las de la carga guardada/);
    await expect(resolveSeedClock(fakeDb(null, { offsetDays: 'diecisiete' }), reference, new Date())).rejects.toThrow(/no es válido/);
  });
});

describe('seedCourseInstant · un instante del curso de la semilla para reservar sus cupos', () => {
  it.each([['2026-11-15T09:30:00Z'], ['2027-08-22T03:00:00Z'], ['2027-08-22T11:59:59Z'], ['2027-08-22T12:00:00Z'], ['2028-02-29T12:00:00Z'], ['2027-08-21T23:00:00Z']])('carga del %s', (iso) => {
    const loadedAt = new Date(iso);
    const clock = seedClockFor(loadedAt);
    const instant = seedCourseInstant(clock);
    expect(academicYearFor(instant)).toBe(clock.academicYear);
    expect(instant.getTime()).toBeLessThanOrEqual(loadedAt.getTime());
    expect(instant.getTime()).toBeGreaterThanOrEqual(clock.now.getTime());
  });
});

describe('ejercicio fiscal de los cobros sembrados · en hora de España, como un cobro real', () => {
  it('un cobro que cae en Nochevieja después de las 23:00 UTC es ya del año siguiente (carga del 2027-01-15 a las 13:00 UTC)', () => {
    const clock = seedClockFor(new Date('2027-01-15T13:00:00Z'));
    const plan = shiftFundingPlans(planAllFunding(reference), clock).find((candidate) => candidate.initiativeId === 1)!;
    const payment = plan.payments.find((candidate) => candidate.key === 'i1-donation-0019')!;
    expect(payment.createdAt.toISOString().slice(0, 10)).toBe('2026-12-31');
    expect(payment.createdAt.getUTCHours()).toBe(23);
    expect(contributionRow(payment, { organizationId: 'CERVANTES', initiativeId: 1 }, 'ca', true).fiscalYear).toBe(2027);
  });

  it.each(loadingDays().slice(0, 40).map((day) => [day.toISOString()]))('carga del %s: cada cobro lleva el ejercicio de su fecha en Madrid', (iso) => {
    const clock = seedClockFor(new Date(iso));
    for (const plan of shiftFundingPlans(planAllFunding(reference), clock)) {
      for (const payment of plan.payments) {
        expect(contributionRow(payment, { organizationId: plan.organizationId, initiativeId: plan.initiativeId }, 'es', true).fiscalYear).toBe(spanishFiscalYear(payment.createdAt));
      }
    }
  });
});
