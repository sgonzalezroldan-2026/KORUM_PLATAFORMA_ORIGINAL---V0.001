import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InsufficientQuotaError, releaseInitiativeQuotas, reserveInitiativeQuotas } from '@/core/finance/quota-reservation';
import type { KorumPrismaClient } from '@/lib/prisma';
import { createInitiative, createOrganization, createTestClient } from './test-database';

let db: KorumPrismaClient;

beforeAll(() => {
  db = createTestClient();
});

afterAll(async () => {
  await db.$disconnect();
});

const quotasOf = (id: string) =>
  db.organization.findUniqueOrThrow({ where: { id }, select: { exemptRemainingCents: true, medalGrantAvailableCents: true, maintPaidCents: true } });
const marksOf = (id: number) => db.initiative.findUniqueOrThrow({ where: { id }, select: { quotaReservedAt: true, quotaReleasedAt: true } });

describe('QA-FIN01 · reversibilidad de exenciones y medallas', () => {
  it('1.000 € exentos + 1.000 € de beca Plata se reservan y vuelven íntegros al cancelar', async () => {
    const organization = await createOrganization(db, { exemptLimitCents: 100_000, exemptRemainingCents: 100_000, medalGrantAvailableCents: 100_000, medalRank: 2 });
    const initiative = await createInitiative(db, organization.id, { defaultExemptAppliedCents: 100_000, medalExemptAppliedCents: 100_000, medalRankApplied: 2 });

    expect(await reserveInitiativeQuotas(db, initiative.id)).toEqual({ reserved: true });
    expect(await quotasOf(organization.id)).toEqual({ exemptRemainingCents: 0, medalGrantAvailableCents: 0, maintPaidCents: 0 });

    expect(await releaseInitiativeQuotas(db, initiative.id)).toEqual({ released: true, credited: true });
    expect(await quotasOf(organization.id)).toEqual({ exemptRemainingCents: 100_000, medalGrantAvailableCents: 100_000, maintPaidCents: 0 });
  });

  it('reservar y devolver son idempotentes: repetirlas no descuenta ni devuelve dos veces', async () => {
    const organization = await createOrganization(db, { exemptRemainingCents: 100_000, medalGrantAvailableCents: 50_000 });
    const initiative = await createInitiative(db, organization.id, { defaultExemptAppliedCents: 40_000, medalExemptAppliedCents: 50_000 });

    await reserveInitiativeQuotas(db, initiative.id);
    expect(await reserveInitiativeQuotas(db, initiative.id)).toEqual({ reserved: false });
    expect(await quotasOf(organization.id)).toMatchObject({ exemptRemainingCents: 60_000, medalGrantAvailableCents: 0 });

    await releaseInitiativeQuotas(db, initiative.id);
    expect(await releaseInitiativeQuotas(db, initiative.id)).toEqual({ released: false, credited: false });
    expect(await quotasOf(organization.id)).toMatchObject({ exemptRemainingCents: 100_000, medalGrantAvailableCents: 50_000 });
  });

  it('si no queda cupo, falla sin tocar la entidad ni marcar la iniciativa', async () => {
    const organization = await createOrganization(db, { exemptRemainingCents: 50_000, medalGrantAvailableCents: 0 });
    const initiative = await createInitiative(db, organization.id, { defaultExemptAppliedCents: 100_000 });

    await expect(reserveInitiativeQuotas(db, initiative.id)).rejects.toBeInstanceOf(InsufficientQuotaError);
    expect(await quotasOf(organization.id)).toMatchObject({ exemptRemainingCents: 50_000 });
    expect((await marksOf(initiative.id)).quotaReservedAt).toBeNull();
  });

  it('aunque quien llama capture el error y confirme su transacción, la iniciativa no queda marcada (auditoría 1.2)', async () => {
    const organization = await createOrganization(db, { exemptRemainingCents: 10_000, medalGrantAvailableCents: 0 });
    const initiative = await createInitiative(db, organization.id, { defaultExemptAppliedCents: 50_000 });

    const outcome = await db.$transaction(async (tx) => {
      try {
        await reserveInitiativeQuotas(tx, initiative.id);
        return 'reservada';
      } catch (error) {
        return error instanceof InsufficientQuotaError ? 'rechazada y capturada' : 'otro error';
      }
    });
    expect(outcome).toBe('rechazada y capturada');
    expect((await marksOf(initiative.id)).quotaReservedAt).toBeNull();

    // Una liberación posterior no puede «devolver» un cupo que nunca se consumió.
    expect(await releaseInitiativeQuotas(db, initiative.id)).toEqual({ released: false, credited: false });
    expect(await quotasOf(organization.id)).toMatchObject({ exemptRemainingCents: 10_000, medalGrantAvailableCents: 0 });
  });

  it('el mantenimiento respeta el tope anual (Colegio San José: 98 € pagados, tope 147 €)', async () => {
    const organization = await createOrganization(db, { maintActive: true, maintPerInitCents: 4_900, maintAnnualCapCents: 14_700, maintPaidCents: 9_800 });
    const third = await createInitiative(db, organization.id, { maintFeeCents: 4_900 });
    const fourth = await createInitiative(db, organization.id, { maintFeeCents: 4_900 });

    await reserveInitiativeQuotas(db, third.id);
    expect(await quotasOf(organization.id)).toMatchObject({ maintPaidCents: 14_700 });
    await expect(reserveInitiativeQuotas(db, fourth.id)).rejects.toBeInstanceOf(InsufficientQuotaError);
    expect((await marksOf(fourth.id)).quotaReservedAt).toBeNull();

    await releaseInitiativeQuotas(db, third.id);
    expect(await quotasOf(organization.id)).toMatchObject({ maintPaidCents: 9_800 });
  });

  it('dos campañas que compiten por el mismo cupo: solo una se lo queda', async () => {
    const organization = await createOrganization(db, { exemptRemainingCents: 100_000 });
    const first = await createInitiative(db, organization.id, { defaultExemptAppliedCents: 100_000 });
    const second = await createInitiative(db, organization.id, { defaultExemptAppliedCents: 100_000 });

    const results = await Promise.allSettled([reserveInitiativeQuotas(db, first.id), reserveInitiativeQuotas(db, second.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await quotasOf(organization.id)).toMatchObject({ exemptRemainingCents: 0 });
    const marked = await Promise.all([marksOf(first.id), marksOf(second.id)]);
    expect(marked.filter((marks) => marks.quotaReservedAt !== null)).toHaveLength(1);
  });

  it('se devuelve lo que se reservó aunque después cambie el presupuesto', async () => {
    const organization = await createOrganization(db, { exemptRemainingCents: 100_000, medalGrantAvailableCents: 100_000 });
    const initiative = await createInitiative(db, organization.id, { defaultExemptAppliedCents: 30_000, medalExemptAppliedCents: 20_000 });
    await reserveInitiativeQuotas(db, initiative.id);
    await db.initiative.update({ where: { id: initiative.id }, data: { defaultExemptAppliedCents: 90_000, medalExemptAppliedCents: 90_000 } });

    await releaseInitiativeQuotas(db, initiative.id);
    expect(await quotasOf(organization.id)).toMatchObject({ exemptRemainingCents: 100_000, medalGrantAvailableCents: 100_000 });
  });

  it('si los cupos ya son de otro curso, la reserva se cierra sin abonar al curso nuevo', async () => {
    const organization = await createOrganization(db, { quotaPeriod: '2026-2027', exemptRemainingCents: 100_000, maintPaidCents: 0, maintAnnualCapCents: 14_700 });
    const initiative = await createInitiative(db, organization.id, { defaultExemptAppliedCents: 60_000, maintFeeCents: 4_900 });
    await reserveInitiativeQuotas(db, initiative.id);
    // Renovación anual: cupos nuevos para el curso siguiente.
    await db.organization.update({ where: { id: organization.id }, data: { quotaPeriod: '2027-2028', exemptRemainingCents: 100_000, maintPaidCents: 0 } });

    expect(await releaseInitiativeQuotas(db, initiative.id)).toEqual({ released: true, credited: false });
    expect(await quotasOf(organization.id)).toMatchObject({ exemptRemainingCents: 100_000, maintPaidCents: 0 });
  });

  it('devolver abona exactamente lo reservado: el exento nunca supera el límite anual y la beca no se recorta aunque la beca del nivel haya bajado entretanto', async () => {
    await db.medalTierConfig.upsert({
      where: { key: 'silver' },
      create: { key: 'silver', name: 'Plata', icon: '🥈', rank: 2, campaignsRequired: 2, grantCents: 100_000 },
      update: {}
    });
    const silver = await db.medalTierConfig.findUniqueOrThrow({ where: { key: 'silver' } });
    const organization = await createOrganization(db, { exemptLimitCents: 100_000, exemptRemainingCents: 100_000, medalRank: 2, medalGrantAvailableCents: 100_000 });
    const initiative = await createInitiative(db, organization.id, { defaultExemptAppliedCents: 30_000, medalExemptAppliedCents: 100_000 });
    await reserveInitiativeQuotas(db, initiative.id);
    // Entre medias, el exento se recarga por otra vía (corrección manual) y el motor de reglas baja la beca del nivel; la entidad conserva la de este curso.
    await db.organization.update({ where: { id: organization.id }, data: { exemptRemainingCents: 100_000 } });
    await db.medalTierConfig.update({ where: { key: 'silver' }, data: { grantCents: 50_000 } });
    try {
      await releaseInitiativeQuotas(db, initiative.id);
      // El exento no pasa del límite anual; la beca vuelve entera (100.000 reservados, ninguno recortado por la beca vigente de 50.000).
      expect(await quotasOf(organization.id)).toMatchObject({ exemptRemainingCents: 100_000, medalGrantAvailableCents: 100_000 });
    } finally {
      await db.medalTierConfig.update({ where: { key: 'silver' }, data: { grantCents: silver.grantCents } });
    }
  });

  it('una campaña reabierta tras la devolución vuelve a reservar (y a descontar)', async () => {
    const organization = await createOrganization(db, { exemptRemainingCents: 100_000 });
    const initiative = await createInitiative(db, organization.id, { defaultExemptAppliedCents: 25_000 });
    await reserveInitiativeQuotas(db, initiative.id);
    await releaseInitiativeQuotas(db, initiative.id);

    expect(await reserveInitiativeQuotas(db, initiative.id)).toEqual({ reserved: true });
    expect(await quotasOf(organization.id)).toMatchObject({ exemptRemainingCents: 75_000 });
    expect(await marksOf(initiative.id)).toMatchObject({ quotaReleasedAt: null });
  });

  it('devolver una iniciativa que nunca reservó no hace nada; una iniciativa inexistente es un error', async () => {
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id, { defaultExemptAppliedCents: 10_000 });
    expect(await releaseInitiativeQuotas(db, initiative.id)).toEqual({ released: false, credited: false });
    expect(await quotasOf(organization.id)).toMatchObject({ exemptRemainingCents: 100_000 });
    await expect(reserveInitiativeQuotas(db, 999_999_999)).rejects.toThrow();
  });

  it('dentro de una transacción ajena, si algo falla después, la reserva se deshace', async () => {
    const organization = await createOrganization(db, { exemptRemainingCents: 100_000 });
    const initiative = await createInitiative(db, organization.id, { defaultExemptAppliedCents: 25_000 });

    await expect(
      db.$transaction(async (tx) => {
        await reserveInitiativeQuotas(tx, initiative.id);
        throw new Error('la publicación de la campaña falla');
      })
    ).rejects.toThrow('falla');
    expect(await quotasOf(organization.id)).toMatchObject({ exemptRemainingCents: 100_000 });
    expect((await marksOf(initiative.id)).quotaReservedAt).toBeNull();
  });
});
