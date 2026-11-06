import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reactivateRejectedRefund } from '@/core/jobs/handlers/mass-refund';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import { markSessionReauthenticated, verifySuperadminSession, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import type { KorumPrismaClient } from '@/lib/prisma';
import { resolveUnknownInvoice } from '@/services/invoicing/invoice.service';
import { resolveUnknownRefund } from '@/services/payments/manual-resolutions';
import { RefundNotAllowedError } from '@/services/payments/payment-reversals';
import { resolveUnknownSplit } from '@/services/payments/split-transfer.service';
import { createTestClient, createUser, uniqueId, verifiedSuperadmin } from './test-database';

/**
 * Las cuatro resoluciones manuales de dinero y facturas solo aceptan un `VerifiedSuperadminActor` (Sprint 3.2): cuenta de Super-Admin con
 * 2FA y una sesión que superó el TOTP hace menos de 10 minutos. Quien no lo cumple ni siquiera obtiene el actor, y queda en la auditoría.
 */

let db: KorumPrismaClient;

beforeAll(() => {
  db = createTestClient();
});

afterAll(async () => {
  await db.$disconnect();
});

const MISSING_ID = 2_000_000_000;

async function sessionFor(userId: string, secondFactorMinutesAgo: number | null) {
  const session = await db.session.create({ data: { id: uniqueId('ses'), token: uniqueId('tok'), userId, expiresAt: new Date(Date.now() + 3_600_000) } });
  if (secondFactorMinutesAgo !== null) await markSessionReauthenticated(db, session.id, { secondFactor: true }, new Date(Date.now() - secondFactorMinutesAgo * 60_000));
  return session;
}

describe('resolución manual solo para el Super-Admin verificado', () => {
  it('una cuenta corriente, un Super-Admin sin 2FA o con el TOTP caducado no obtienen el actor, y queda en la auditoría', async () => {
    const person = await createUser(db);
    const noTwoFactor = await createUser(db, { isSuperadmin: true, twoFactorEnabled: false });
    const stale = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    const emailOnly = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    const cases: Array<[string, number | null, string]> = [
      [person.id, 1, 'NOT_SUPERADMIN'],
      [noTwoFactor.id, 1, 'TWO_FACTOR_REQUIRED'],
      [stale.id, 11, 'REAUTH_REQUIRED'],
      [emailOnly.id, null, 'REAUTH_REQUIRED']
    ];
    for (const [userId, minutesAgo, reason] of cases) {
      const session = await sessionFor(userId, minutesAgo);
      await expect(verifySuperadminSession(db, { userId, sessionId: session.id, operation: 'payment.resolve_unknown_refund' })).rejects.toMatchObject({ name: 'SuperadminRequiredError', reason });
      expect(await db.auditLog.count({ where: { actorUserId: userId, action: 'tenant.access_denied' } })).toBe(1);
    }
  });

  it('un actor fabricado a mano no sirve en ninguna de las cuatro operaciones', async () => {
    const admin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    const forged = { kind: 'verified-superadmin', userId: admin.id, sessionId: 'inventada' } as VerifiedSuperadminActor;
    const attempts = [
      resolveUnknownRefund(db, forged, MISSING_ID, { refunded: true }),
      resolveUnknownSplit(db, forged, MISSING_ID, { splitAuthCode: 'S-FALSO' }),
      resolveUnknownInvoice(db, forged, MISSING_ID, { registered: false }),
      reactivateRejectedRefund(db, forged, MISSING_ID)
    ];
    for (const attempt of attempts) await expect(attempt).rejects.toMatchObject({ name: 'SuperadminRequiredError', reason: 'SESSION_INVALID' });
  });

  it('pasados 10 minutos desde el TOTP, el mismo actor deja de valer', async () => {
    const now = new Date();
    const { actor } = await verifiedSuperadmin(db, now);
    await expect(resolveUnknownRefund(db, actor, MISSING_ID, { refunded: true }, new Date(now.getTime() + 10 * 60_000))).rejects.toMatchObject({ reason: 'REAUTH_REQUIRED' });
  });

  it('si la sesión se cierra o la cuenta deja de ser Super-Admin, la operación se rechaza dentro de la transacción', async () => {
    const closed = await verifiedSuperadmin(db);
    await db.session.delete({ where: { id: closed.session.id } });
    await expect(resolveUnknownRefund(db, closed.actor, MISSING_ID, { refunded: true })).rejects.toBeInstanceOf(SuperadminRequiredError);

    const demoted = await verifiedSuperadmin(db);
    await db.user.update({ where: { id: demoted.admin.id }, data: { isSuperadmin: false } });
    await expect(resolveUnknownInvoice(db, demoted.actor, MISSING_ID, { registered: false })).rejects.toMatchObject({ reason: 'SESSION_INVALID' });
  });

  it('un Super-Admin verificado supera la guardia y llega a la comprobación del caso', async () => {
    const { admin, actor } = await verifiedSuperadmin(db);
    await expect(resolveUnknownRefund(db, actor, MISSING_ID, { refunded: true })).rejects.toBeInstanceOf(RefundNotAllowedError);
    expect(await db.auditLog.count({ where: { actorUserId: admin.id, action: 'tenant.access_denied' } })).toBe(0);
  });
});
