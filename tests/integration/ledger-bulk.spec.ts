import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostJournalInput } from '@/core/finance/ledger-accounts';
import { getAccountBalance, IdempotencyConflictError } from '@/core/finance/ledger.service';
import { LedgerValidationError } from '@/core/finance/ledger-validation';
import type { KorumPrismaClient } from '@/lib/prisma';
import { postJournalsBulk } from '@/seed/ledger-bulk';
import { createInitiative, createOrganization, createTestClient, TEST_SCHEMA, uniqueId } from './test-database';

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

function donation(orgId: string, initiativeId: number, key: string, amountCents = 2_500): PostJournalInput {
  return {
    idempotencyKey: key,
    kind: 'PAYIN_DONATION',
    description: 'Donación de la carga masiva',
    organizationId: orgId,
    initiativeId,
    lines: [
      { account: 'PSP_CLEARING', direction: 'DEBIT', amountCents, organizationId: orgId },
      { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents, organizationId: orgId, initiativeId }
    ]
  };
}

describe('carga masiva de asientos (solo semillas)', () => {
  it('inserta varios asientos con sus apuntes y repetir la carga no duplica nada', async () => {
    const { orgId, initiativeId } = await scenario();
    const inputs = [1, 2, 3].map((index) => donation(orgId, initiativeId, uniqueId(`bulk-${index}`), index * 1_000));

    expect(await postJournalsBulk(db, TEST_SCHEMA, inputs)).toEqual({ inserted: 3, skipped: 0 });
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId })).balanceCents).toBe(6_000);

    expect(await postJournalsBulk(db, TEST_SCHEMA, inputs)).toEqual({ inserted: 0, skipped: 3 });
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId })).balanceCents).toBe(6_000);
  });

  it('una clave ya existente con otro importe, otro tipo o otra iniciativa se rechaza, no se da por buena', async () => {
    const { orgId, initiativeId } = await scenario();
    const key = uniqueId('bulk-conflict');
    await postJournalsBulk(db, TEST_SCHEMA, [donation(orgId, initiativeId, key)]);

    await expect(postJournalsBulk(db, TEST_SCHEMA, [donation(orgId, initiativeId, key, 2_600)])).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(postJournalsBulk(db, TEST_SCHEMA, [{ ...donation(orgId, initiativeId, key), kind: 'PAYIN_TICKET' }])).rejects.toBeInstanceOf(IdempotencyConflictError);
    const other = await createInitiative(db, orgId);
    await expect(postJournalsBulk(db, TEST_SCHEMA, [donation(orgId, other.id, key)])).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId })).balanceCents).toBe(2_500);
  });

  it('mezclar asientos nuevos con uno existente distinto no inserta ninguno de ese lote', async () => {
    const { orgId, initiativeId } = await scenario();
    const existing = uniqueId('bulk-existing');
    await postJournalsBulk(db, TEST_SCHEMA, [donation(orgId, initiativeId, existing)]);

    const fresh = donation(orgId, initiativeId, uniqueId('bulk-fresh'), 700);
    await expect(postJournalsBulk(db, TEST_SCHEMA, [fresh, donation(orgId, initiativeId, existing, 9_900)])).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await db.ledgerJournal.count({ where: { idempotencyKey: fresh.idempotencyKey } })).toBe(0);
  });

  it('valida cada asiento en memoria: descuadres, claves repetidas y nombres de esquema no válidos', async () => {
    const { orgId, initiativeId } = await scenario();
    const unbalanced = donation(orgId, initiativeId, uniqueId('bulk-unbalanced'));
    unbalanced.lines[0] = { ...unbalanced.lines[0]!, amountCents: 2_600 };
    await expect(postJournalsBulk(db, TEST_SCHEMA, [unbalanced])).rejects.toBeInstanceOf(LedgerValidationError);

    const repeated = donation(orgId, initiativeId, uniqueId('bulk-repeated'));
    await expect(postJournalsBulk(db, TEST_SCHEMA, [repeated, repeated])).rejects.toThrow(/repetida/);
    await expect(postJournalsBulk(db, 'public"; DROP TABLE "User"; --', [repeated])).rejects.toThrow(/esquema/);
    expect(await db.ledgerJournal.count({ where: { idempotencyKey: repeated.idempotencyKey } })).toBe(0);
  });
});
