import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRootDb, isTransactionDb } from '@/lib/db';
import { recordAudit, type AuditDb } from '@/repositories/tenant-guard';
import { payoutBlockers } from '@/services/payouts/payout-readiness';

/**
 * Errores de base de datos dentro de una transacción (Prisma 7: el cliente de una transacción tiene `$transaction` pero no `$disconnect`). Un error de PostgreSQL
 * deja la transacción abortada: lo que venga después falla con «transacción abortada» (25P02) y esconde la causa, así que no se puede tragar ni convertir en otro motivo.
 */

const root = { $transaction: () => undefined, $disconnect: () => undefined };
const transaction = { $transaction: () => undefined };
const plainObject = {};

describe('cliente raíz frente a cliente de transacción', () => {
  it('solo el raíz tiene $transaction y $disconnect; un objeto cualquiera no es ni uno ni otro', () => {
    expect(isRootDb(root as never)).toBe(true);
    expect(isTransactionDb(root)).toBe(false);
    expect(isRootDb(transaction as never)).toBe(false);
    expect(isTransactionDb(transaction)).toBe(true);
    expect(isRootDb(plainObject as never)).toBe(false);
    expect(isTransactionDb(plainObject)).toBe(false);
  });
});

describe('recordAudit y los errores de base de datos', () => {
  const actor = { kind: 'user', userId: 'u1', memberships: [], isSuperadmin: false } as never;
  const entry = { action: 'x.y', organizationId: null, targetType: 'Thing', targetId: '1', metadata: {} };
  const failing = (shape: object) => ({ ...shape, auditLog: { create: vi.fn(async () => Promise.reject(new Error('fallo de base de datos'))) } }) as unknown as AuditDb;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fuera de una transacción un fallo se registra en el servidor y no cambia el resultado', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(recordAudit(failing(root), actor, entry)).resolves.toBeUndefined();
    await expect(recordAudit(failing(plainObject), actor, entry)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('dentro de una transacción el fallo se propaga: la transacción ya está abortada y seguir solo escondería la causa', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(recordAudit(failing(transaction), actor, entry)).rejects.toThrow('fallo de base de datos');
    expect(spy).not.toHaveBeenCalled();
  });

  it('con required: true siempre se propaga', async () => {
    await expect(recordAudit(failing(root), actor, entry, { required: true })).rejects.toThrow('fallo de base de datos');
  });
});

describe('payoutBlockers: «ventana vencida» solo cuando de verdad vence', () => {
  const initiative = { id: 7, status: 'GOAL_REACHED', ticketSubtype: null, rafflePrizeCount: null, raisedCents: 100_000, bracketFeeCents: 1_000, maintFeeCents: 0, gatewayFeeCents: 0, absorbsGatewayCostByKorum: true };
  const organization = { kybStatus: 'VERIFIED', archivedAt: null, paycometSplitId: 'split-1' };
  const options = { destination: 'ORGANIZATION' as const, payoutId: null, now: new Date('2026-11-13T10:00:00Z') };
  const fakeTx = (findMany: () => Promise<unknown[]>) =>
    ({
      raffleDraw: { count: async () => 0 },
      sponsor: { count: async () => 0 },
      contribution: { findMany },
      sponsorAllocation: { findMany: async () => [] },
      escrowPayoutSplit: { groupBy: async () => [] },
      activityFundSplit: { groupBy: async () => [] }
    }) as never;

  it('sin cobros dentro de los 90 días para repartir el neto, avisa WINDOW_EXPIRED', async () => {
    expect(await payoutBlockers(fakeTx(async () => []), initiative, organization, options)).toEqual(['WINDOW_EXPIRED']);
  });

  it('un error de base de datos al buscar los cobros NO se disfraza de ventana vencida: se propaga', async () => {
    await expect(payoutBlockers(fakeTx(() => Promise.reject(new Error('fallo de base de datos'))), initiative, organization, options)).rejects.toThrow('fallo de base de datos');
  });
});
