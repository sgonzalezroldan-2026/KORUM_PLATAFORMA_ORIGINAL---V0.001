import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reactivateRejectedRefund } from '@/core/jobs/handlers/mass-refund';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import type { KorumPrismaClient } from '@/lib/prisma';
import { resolveUnknownInvoice } from '@/services/invoicing/invoice.service';
import { resolveUnknownRefund } from '@/services/payments/manual-resolutions';
import { RefundNotAllowedError } from '@/services/payments/payment-reversals';
import { resolveUnknownSplit } from '@/services/payments/split-transfer.service';
import { createTestClient, createUser } from './test-database';

/** Las tres resoluciones manuales de dinero y facturas exigen una cuenta de Super-Admin con verificación en dos pasos, y dejan rastro si no. */

let db: KorumPrismaClient;

beforeAll(() => {
  db = createTestClient();
});

afterAll(async () => {
  await db.$disconnect();
});

const MISSING_ID = 2_000_000_000;

describe('resolución manual solo para Super-Admin con 2FA', () => {
  it('una cuenta corriente es rechazada en las tres operaciones y queda en la auditoría', async () => {
    const person = await createUser(db);
    const attempts = [
      resolveUnknownRefund(db, MISSING_ID, { refunded: true, resolvedById: person.id }),
      resolveUnknownSplit(db, MISSING_ID, { splitAuthCode: 'S-FALSO', resolvedById: person.id }),
      resolveUnknownInvoice(db, MISSING_ID, { registered: false, resolvedById: person.id }),
      reactivateRejectedRefund(db, MISSING_ID, person.id)
    ];
    for (const attempt of attempts) await expect(attempt).rejects.toMatchObject({ name: 'SuperadminRequiredError', reason: 'NOT_SUPERADMIN' });
    const denied = await db.auditLog.findMany({ where: { actorUserId: person.id, action: 'tenant.access_denied' }, orderBy: { id: 'asc' } });
    expect(denied.map((row) => (row.metadataJson as { attempted: string }).attempted).sort()).toEqual(['invoice.resolve_unknown', 'payment.reactivate_refund', 'payment.resolve_unknown_refund', 'payout.resolve_unknown_split']);
    // El aviso guarda a qué caso se intentó acceder (un identificador, no un dato personal).
    expect(denied.every((row) => row.targetId === String(MISSING_ID))).toBe(true);
  });

  it('un Super-Admin sin verificación en dos pasos también es rechazado', async () => {
    const admin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: false });
    await expect(resolveUnknownRefund(db, MISSING_ID, { refunded: true, resolvedById: admin.id })).rejects.toMatchObject({ reason: 'TWO_FACTOR_REQUIRED' });
    await expect(resolveUnknownRefund(db, MISSING_ID, { refunded: true, resolvedById: admin.id })).rejects.toBeInstanceOf(SuperadminRequiredError);
    expect(await db.auditLog.count({ where: { actorUserId: admin.id, action: 'tenant.access_denied' } })).toBe(2);
  });

  it('una cuenta de Super-Admin ya anonimizada tampoco puede resolver', async () => {
    const admin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true, gdprAnonymizedAt: new Date() });
    await expect(resolveUnknownRefund(db, MISSING_ID, { refunded: true, resolvedById: admin.id })).rejects.toMatchObject({ reason: 'NOT_SUPERADMIN' });
  });

  it('una cuenta que no existe es rechazada sin romper la auditoría', async () => {
    await expect(resolveUnknownRefund(db, MISSING_ID, { refunded: true, resolvedById: 'no-existe' })).rejects.toMatchObject({ reason: 'NOT_SUPERADMIN' });
  });

  it('un Super-Admin con 2FA supera la guardia y llega a la comprobación del caso', async () => {
    const admin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    await expect(resolveUnknownRefund(db, MISSING_ID, { refunded: true, resolvedById: admin.id })).rejects.toBeInstanceOf(RefundNotAllowedError);
    expect(await db.auditLog.count({ where: { actorUserId: admin.id, action: 'tenant.access_denied' } })).toBe(0);
  });
});
