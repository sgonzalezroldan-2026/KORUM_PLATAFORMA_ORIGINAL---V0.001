import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostJournalInput } from '@/core/finance/ledger-accounts';
import { getAccountBalance, IdempotencyConflictError, JournalReversalError, postJournal, reverseJournal } from '@/core/finance/ledger.service';
import { LedgerValidationError } from '@/core/finance/ledger-validation';
import { ImmutableRecordError, type KorumPrismaClient } from '@/lib/prisma';
import { createInitiative, createOrganization, createTestClient, table, uniqueId } from './test-database';

/** Defensas añadidas tras la auditoría financiera del Sprint 1.2. */

let db: KorumPrismaClient;

beforeAll(() => {
  db = createTestClient();
});

afterAll(async () => {
  await db.$disconnect();
});

async function scenario() {
  const organization = await createOrganization(db);
  const initiative = await createInitiative(db, organization.id);
  return { orgId: organization.id, initiativeId: initiative.id };
}

function payin(orgId: string, initiativeId: number, overrides: Partial<PostJournalInput> = {}): PostJournalInput {
  return {
    idempotencyKey: uniqueId('payin'),
    kind: 'PAYIN_DONATION',
    description: 'Donación de 25 €',
    organizationId: orgId,
    initiativeId,
    lines: [
      { account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: 2_500, organizationId: orgId },
      { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: 2_500, organizationId: orgId, initiativeId }
    ],
    ...overrides
  };
}

describe('un asiento confirmado no admite apuntes nuevos', () => {
  it('con SQL directo, añadir un par cuadrado a un asiento antiguo falla y la hucha no cambia', async () => {
    const { orgId, initiativeId } = await scenario();
    const { journal } = await postJournal(db, payin(orgId, initiativeId));

    const sql = `INSERT INTO ${table('EscrowLedgerEntry')} ("journalId", "account", "direction", "amountCents", "organizationId", "initiativeId")
      VALUES (${journal.id}, 'PSP_CLEARING', 'DEBIT', 100000, '${orgId}', NULL),
             (${journal.id}, 'INITIATIVE_ESCROW', 'CREDIT', 100000, '${orgId}', ${initiativeId})`;
    await expect(db.$executeRawUnsafe(sql)).rejects.toThrow(/KORUM_IMMUTABLE/);

    expect(await db.escrowLedgerEntry.count({ where: { journalId: journal.id } })).toBe(2);
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId })).balanceCents).toBe(2_500);
  });

  it('tampoco desde una transacción interactiva de la aplicación', async () => {
    const { orgId, initiativeId } = await scenario();
    const { journal } = await postJournal(db, payin(orgId, initiativeId));
    await expect(
      db.$transaction((tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO ${table('EscrowLedgerEntry')} ("journalId", "account", "direction", "amountCents") VALUES (${journal.id}, 'GATEWAY_FEES_EXPENSE', 'DEBIT', 10), (${journal.id}, 'PSP_CLEARING', 'CREDIT', 10)`
        )
      )
    ).rejects.toThrow(/KORUM_IMMUTABLE/);
  });

  it('la aplicación no deja crear apuntes sueltos ni asientos en bloque', async () => {
    const { orgId, initiativeId } = await scenario();
    const { journal } = await postJournal(db, payin(orgId, initiativeId));
    const loose = { journalId: journal.id, account: 'PSP_CLEARING' as const, direction: 'DEBIT' as const, amountCents: 1 };

    await expect(db.escrowLedgerEntry.create({ data: loose })).rejects.toBeInstanceOf(ImmutableRecordError);
    await expect(db.escrowLedgerEntry.createMany({ data: [loose] })).rejects.toBeInstanceOf(ImmutableRecordError);
    await expect(db.ledgerJournal.createMany({ data: [{ idempotencyKey: uniqueId('bulk'), kind: 'GATEWAY_FEE', description: 'en bloque' }] })).rejects.toBeInstanceOf(
      ImmutableRecordError
    );
  });
});

describe('las dimensiones de los apuntes existen y son coherentes', () => {
  it('rechaza una iniciativa que no existe (sin huchas fantasma)', async () => {
    const { orgId } = await scenario();
    await expect(postJournal(db, payin(orgId, 999_999_999))).rejects.toThrow(/no existe la iniciativa 999999999/);
  });

  it('rechaza apuntar dinero de una entidad en la iniciativa de otra', async () => {
    const { orgId } = await scenario();
    const other = await scenario();
    const input = payin(orgId, other.initiativeId);
    await expect(postJournal(db, input)).rejects.toBeInstanceOf(LedgerValidationError);
    await expect(postJournal(db, input)).rejects.toThrow(new RegExp(`es de la entidad ${other.orgId}`));
  });

  it('la base de datos rechaza un apunte con una entidad inexistente (clave foránea)', async () => {
    const { orgId, initiativeId } = await scenario();
    await expect(
      db.ledgerJournal.create({
        data: {
          idempotencyKey: uniqueId('fk'),
          kind: 'GATEWAY_FEE',
          description: 'Entidad inexistente',
          entries: {
            create: [
              { account: 'GATEWAY_FEES_EXPENSE', direction: 'DEBIT', amountCents: 10, organizationId: 'no-existe' },
              { account: 'PSP_CLEARING', direction: 'CREDIT', amountCents: 10, organizationId: orgId, initiativeId }
            ]
          }
        }
      })
    ).rejects.toThrow();
  });
});

describe('idempotencia: la misma clave solo vale para la misma operación', () => {
  it('distinta referencia de Paycomet con los mismos importes es un conflicto, no un duplicado', async () => {
    const { orgId, initiativeId } = await scenario();
    const input = payin(orgId, initiativeId, { paycometReference: 'ORD-1' });
    await postJournal(db, input);
    await expect(postJournal(db, { ...input, paycometReference: 'ORD-2' })).rejects.toThrow(/referencia de Paycomet distinta/);
    expect((await postJournal(db, input)).created).toBe(false);
  });

  it('dentro de transacciones ajenas, la carrera aborta las perdedoras y al reintentar devuelven el asiento', async () => {
    const { orgId, initiativeId } = await scenario();
    const input = payin(orgId, initiativeId);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => db.$transaction((tx) => postJournal(tx, input))));

    const created = results.filter((result) => result.status === 'fulfilled' && result.value.created);
    expect(created).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') expect((result.reason as { code?: string }).code).toBe('P2002');
    }
    const retry = await db.$transaction((tx) => postJournal(tx, input));
    expect(retry.created).toBe(false);
    expect(await db.ledgerJournal.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(1);
  });
});

describe('contra-asientos simultáneos', () => {
  it('10 anulaciones a la vez con la misma clave crean un único contra-asiento y ninguna falla', async () => {
    const { orgId, initiativeId } = await scenario();
    const { journal } = await postJournal(db, payin(orgId, initiativeId));
    const key = uniqueId('reversal');
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => reverseJournal(db, { journalId: journal.id, idempotencyKey: key, description: 'Webhook de reembolso repetido' }))
    );

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const ids = new Set(results.map((result) => (result.status === 'fulfilled' ? result.value.journal.id : 0)));
    expect(ids.size).toBe(1);
    expect(await db.ledgerJournal.count({ where: { reversesJournalId: journal.id } })).toBe(1);
  });

  it('5 anulaciones a la vez con claves distintas: una gana y las demás reciben JournalReversalError', async () => {
    const { orgId, initiativeId } = await scenario();
    const { journal } = await postJournal(db, payin(orgId, initiativeId));
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => reverseJournal(db, { journalId: journal.id, idempotencyKey: uniqueId('reversal'), description: 'Anulación' }))
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(JournalReversalError);
    }
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId })).balanceCents).toBe(0);
  });

  it('la clave de un contra-asiento tiene las mismas reglas que la de un asiento', async () => {
    const { orgId, initiativeId } = await scenario();
    const { journal } = await postJournal(db, payin(orgId, initiativeId));
    await expect(reverseJournal(db, { journalId: journal.id, idempotencyKey: 'x'.repeat(201), description: 'Anulación' })).rejects.toBeInstanceOf(
      LedgerValidationError
    );
    await expect(reverseJournal(db, { journalId: journal.id, idempotencyKey: uniqueId('payin-key'), description: '' })).rejects.toBeInstanceOf(
      LedgerValidationError
    );
  });

  it('usar la clave de un asiento normal para anular otro es un conflicto', async () => {
    const { orgId, initiativeId } = await scenario();
    const first = await postJournal(db, payin(orgId, initiativeId));
    const second = await postJournal(db, payin(orgId, initiativeId));
    await expect(reverseJournal(db, { journalId: second.journal.id, idempotencyKey: first.journal.idempotencyKey, description: 'Anulación' })).rejects.toBeInstanceOf(
      IdempotencyConflictError
    );
  });
});
