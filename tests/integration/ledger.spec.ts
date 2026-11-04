import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostJournalInput } from '@/core/finance/ledger-accounts';
import {
  getAccountBalance,
  getBalancesByAccount,
  getTrialBalance,
  IdempotencyConflictError,
  JournalReversalError,
  postJournal,
  reverseJournal
} from '@/core/finance/ledger.service';
import { LedgerValidationError } from '@/core/finance/ledger-validation';
import { ImmutableRecordError, type KorumPrismaClient } from '@/lib/prisma';
import { createInitiative, createOrganization, createTestClient, table, uniqueId } from './test-database';

let db: KorumPrismaClient;

beforeAll(() => {
  db = createTestClient();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Entidad e iniciativa nuevas para cada prueba: los saldos de una prueba no se mezclan con los de otra. */
async function scenario() {
  const organization = await createOrganization(db);
  const initiative = await createInitiative(db, organization.id);
  return { orgId: organization.id, initiativeId: initiative.id };
}

/** Donación de 25 € con aportación voluntaria de 1,80 € (skill korum-escrow-payments §2). */
function donation(orgId: string, initiativeId: number, key = uniqueId('payin')): PostJournalInput {
  return {
    idempotencyKey: key,
    kind: 'PAYIN_DONATION',
    description: 'Donación de 25 € + aportación voluntaria de 1,80 €',
    organizationId: orgId,
    initiativeId,
    lines: [
      { account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: 2_680, organizationId: orgId },
      { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: 2_500, organizationId: orgId, initiativeId },
      { account: 'KORUM_REVENUE_GUARANTEE', direction: 'CREDIT', amountCents: 180, organizationId: orgId }
    ]
  };
}

describe('QA-C03 · alta de asientos', () => {
  it('registra el asiento con sus apuntes y Σ DEBIT === Σ CREDIT', async () => {
    const { orgId, initiativeId } = await scenario();
    const { journal, created } = await postJournal(db, donation(orgId, initiativeId));

    expect(created).toBe(true);
    expect(journal.kind).toBe('PAYIN_DONATION');
    expect(journal.entries).toHaveLength(3);
    const debit = journal.entries.filter((entry) => entry.direction === 'DEBIT').reduce((sum, entry) => sum + entry.amountCents, 0);
    const credit = journal.entries.filter((entry) => entry.direction === 'CREDIT').reduce((sum, entry) => sum + entry.amountCents, 0);
    expect(debit).toBe(2_680);
    expect(credit).toBe(2_680);
    expect(journal.entries.every((entry) => entry.amountCents > 0)).toBe(true);
  });

  it('la segunda llamada con la misma clave devuelve el asiento existente sin duplicar nada', async () => {
    const { orgId, initiativeId } = await scenario();
    const input = donation(orgId, initiativeId);
    const first = await postJournal(db, input);
    const second = await postJournal(db, { ...input, lines: [...input.lines].reverse() });

    expect(second.created).toBe(false);
    expect(second.journal.id).toBe(first.journal.id);
    expect(await db.ledgerJournal.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(1);
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId })).balanceCents).toBe(2_500);
  });

  it('la misma clave con otro contenido es un error, nunca se ignora en silencio', async () => {
    const { orgId, initiativeId } = await scenario();
    const input = donation(orgId, initiativeId);
    await postJournal(db, input);

    const altered = { ...input, lines: input.lines.map((line) => (line.account === 'KORUM_REVENUE_GUARANTEE' ? { ...line, amountCents: 100 } : line)) };
    altered.lines[0] = { ...altered.lines[0]!, amountCents: 2_600 };
    await expect(postJournal(db, altered)).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(postJournal(db, { ...input, kind: 'PAYIN_TICKET' })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('20 webhooks simultáneos con la misma clave crean un único asiento y un único abono', async () => {
    const { orgId, initiativeId } = await scenario();
    const input = donation(orgId, initiativeId);
    const results = await Promise.all(Array.from({ length: 20 }, () => postJournal(db, input)));

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.journal.id)).size).toBe(1);
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId })).balanceCents).toBe(2_500);
  });

  it('un asiento descuadrado se rechaza antes de llegar a la base de datos', async () => {
    const { orgId, initiativeId } = await scenario();
    const input = donation(orgId, initiativeId);
    input.lines[1] = { ...input.lines[1]!, amountCents: 2_499 };

    await expect(postJournal(db, input)).rejects.toBeInstanceOf(LedgerValidationError);
    expect(await db.ledgerJournal.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(0);
  });

  it('un asiento que se escribe dentro de una transacción fallida no deja rastro', async () => {
    const { orgId, initiativeId } = await scenario();
    const input = donation(orgId, initiativeId);
    await expect(
      db.$transaction(async (tx) => {
        await postJournal(tx, input);
        throw new Error('fallo posterior en la misma operación');
      })
    ).rejects.toThrow('fallo posterior');
    expect(await db.ledgerJournal.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(0);
  });
});

describe('QA-C03 · la base de datos protege la partida doble aunque se salte el servicio', () => {
  it('rechaza al confirmar un asiento descuadrado escrito directamente', async () => {
    const { orgId, initiativeId } = await scenario();
    const key = uniqueId('raw-unbalanced');
    await expect(
      db.ledgerJournal.create({
        data: {
          idempotencyKey: key,
          kind: 'PAYIN_DONATION',
          description: 'Asiento descuadrado escrito sin el servicio',
          entries: {
            create: [
              { account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: 1_000 },
              { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: 999, organizationId: orgId, initiativeId }
            ]
          }
        }
      })
    ).rejects.toThrow(/KORUM_UNBALANCED/);
    expect(await db.ledgerJournal.count({ where: { idempotencyKey: key } })).toBe(0);
  });

  it('rechaza un asiento con un solo apunte', async () => {
    await expect(
      db.ledgerJournal.create({
        data: {
          idempotencyKey: uniqueId('raw-single'),
          kind: 'GATEWAY_FEE',
          description: 'Un solo apunte',
          entries: { create: [{ account: 'GATEWAY_FEES_EXPENSE', direction: 'DEBIT', amountCents: 36 }] }
        }
      })
    ).rejects.toThrow(/KORUM_UNBALANCED/);
  });

  it('rechaza importes cero o negativos (CHECK amountCents > 0)', async () => {
    for (const amountCents of [0, -500]) {
      await expect(
        db.ledgerJournal.create({
          data: {
            idempotencyKey: uniqueId('raw-zero'),
            kind: 'GATEWAY_FEE',
            description: 'Importe no positivo',
            entries: {
              create: [
                { account: 'GATEWAY_FEES_EXPENSE', direction: 'DEBIT', amountCents },
                { account: 'PSP_CLEARING', direction: 'CREDIT', amountCents }
              ]
            }
          }
        })
      ).rejects.toThrow(/amountCents_positive|check constraint/i);
    }
  });

  it('desde la aplicación no se puede editar ni borrar asientos, apuntes ni auditoría', async () => {
    const { orgId, initiativeId } = await scenario();
    const { journal } = await postJournal(db, donation(orgId, initiativeId));
    const entryId = journal.entries[0]!.id;

    await expect(db.ledgerJournal.update({ where: { id: journal.id }, data: { description: 'cambiado' } })).rejects.toBeInstanceOf(ImmutableRecordError);
    await expect(db.ledgerJournal.deleteMany({ where: { id: journal.id } })).rejects.toBeInstanceOf(ImmutableRecordError);
    await expect(db.escrowLedgerEntry.update({ where: { id: entryId }, data: { amountCents: 1 } })).rejects.toBeInstanceOf(ImmutableRecordError);
    await expect(db.escrowLedgerEntry.delete({ where: { id: entryId } })).rejects.toBeInstanceOf(ImmutableRecordError);
    await expect(db.auditLog.deleteMany({})).rejects.toBeInstanceOf(ImmutableRecordError);
    // La única edición admitida (Sprint 2.5): vaciar a la vez la IP y el navegador vencidos. Con cualquier otro campo, no.
    const audit = await db.auditLog.create({ data: { actorType: 'SYSTEM', action: 'test.audit', targetType: 'X', targetId: uniqueId('a'), ipHash: 'hash', userAgent: 'navegador' } });
    await expect(db.auditLog.updateMany({ where: { id: audit.id }, data: { ipHash: null, userAgent: null, action: 'cambiado' } })).rejects.toBeInstanceOf(ImmutableRecordError);
    await expect(db.auditLog.updateMany({ where: { id: audit.id }, data: { ipHash: 'otra' } })).rejects.toBeInstanceOf(ImmutableRecordError);
    await expect(db.auditLog.update({ where: { id: audit.id }, data: { ipHash: null, userAgent: null } })).rejects.toBeInstanceOf(ImmutableRecordError);
    expect(await db.auditLog.updateMany({ where: { id: audit.id }, data: { ipHash: null, userAgent: null } })).toEqual({ count: 1 });
    expect(await db.auditLog.findUniqueOrThrow({ where: { id: audit.id } })).toMatchObject({ action: 'test.audit', ipHash: null, userAgent: null });
    await expect(
      db.ledgerJournal.upsert({ where: { id: journal.id }, create: { idempotencyKey: uniqueId('x'), kind: 'GATEWAY_FEE', description: 'x' }, update: { description: 'x' } })
    ).rejects.toBeInstanceOf(ImmutableRecordError);
  });

  it('con SQL directo, UPDATE, DELETE y TRUNCATE fallan en las tres tablas protegidas', async () => {
    const { orgId, initiativeId } = await scenario();
    const { journal } = await postJournal(db, donation(orgId, initiativeId));
    await db.auditLog.create({ data: { actorType: 'SYSTEM', action: 'test.audit', targetType: 'LedgerJournal', targetId: String(journal.id) } });

    const attempts = [
      `UPDATE ${table('LedgerJournal')} SET "description" = 'cambiado' WHERE "id" = ${journal.id}`,
      `DELETE FROM ${table('LedgerJournal')} WHERE "id" = ${journal.id}`,
      `UPDATE ${table('EscrowLedgerEntry')} SET "amountCents" = 1 WHERE "journalId" = ${journal.id}`,
      `DELETE FROM ${table('EscrowLedgerEntry')} WHERE "journalId" = ${journal.id}`,
      `UPDATE ${table('AuditLog')} SET "action" = 'borrado'`,
      `DELETE FROM ${table('AuditLog')}`,
      `TRUNCATE ${table('AuditLog')}`,
      `TRUNCATE ${table('EscrowLedgerEntry')}`,
      `TRUNCATE ${table('LedgerJournal')} CASCADE`
    ];
    for (const sql of attempts) {
      await expect(db.$executeRawUnsafe(sql), sql).rejects.toThrow(/KORUM_IMMUTABLE/);
    }
    const stored = await db.ledgerJournal.findUniqueOrThrow({ where: { id: journal.id }, include: { entries: true } });
    expect(stored.description).toBe(journal.description);
    expect(stored.entries).toHaveLength(3);
  });
});

describe('QA-C03 · correcciones con contra-asiento', () => {
  it('el contra-asiento invierte cada apunte, enlaza el original y deja los saldos a cero', async () => {
    const { orgId, initiativeId } = await scenario();
    const { journal } = await postJournal(db, donation(orgId, initiativeId));
    const { journal: reversal, created } = await reverseJournal(db, {
      journalId: journal.id,
      idempotencyKey: uniqueId('reversal'),
      description: 'Cobro duplicado por error del simulador',
      createdById: 'system'
    });

    expect(created).toBe(true);
    expect(reversal.kind).toBe('REVERSAL');
    expect(reversal.reversesJournalId).toBe(journal.id);
    expect(reversal.initiativeId).toBe(initiativeId);
    for (const entry of journal.entries) {
      const mirrored = reversal.entries.find((candidate) => candidate.account === entry.account && candidate.amountCents === entry.amountCents);
      expect(mirrored?.direction).toBe(entry.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT');
    }
    const balances = await getBalancesByAccount(db, { organizationId: orgId });
    expect(balances.every((balance) => balance.balanceCents === 0)).toBe(true);
  });

  it('repetir la anulación con la misma clave devuelve el mismo contra-asiento', async () => {
    const { orgId, initiativeId } = await scenario();
    const { journal } = await postJournal(db, donation(orgId, initiativeId));
    const key = uniqueId('reversal');
    const first = await reverseJournal(db, { journalId: journal.id, idempotencyKey: key, description: 'Anulación' });
    const again = await reverseJournal(db, { journalId: journal.id, idempotencyKey: key, description: 'Anulación' });
    expect(again.created).toBe(false);
    expect(again.journal.id).toBe(first.journal.id);
  });

  it('un asiento no se anula dos veces y un contra-asiento no se anula', async () => {
    const { orgId, initiativeId } = await scenario();
    const { journal } = await postJournal(db, donation(orgId, initiativeId));
    const { journal: reversal } = await reverseJournal(db, { journalId: journal.id, idempotencyKey: uniqueId('rev'), description: 'Anulación' });

    await expect(reverseJournal(db, { journalId: journal.id, idempotencyKey: uniqueId('rev'), description: 'Otra vez' })).rejects.toBeInstanceOf(
      JournalReversalError
    );
    await expect(reverseJournal(db, { journalId: reversal.id, idempotencyKey: uniqueId('rev'), description: 'Anular la anulación' })).rejects.toBeInstanceOf(
      JournalReversalError
    );
    await expect(reverseJournal(db, { journalId: 999_999_999, idempotencyKey: uniqueId('rev'), description: 'No existe' })).rejects.toBeInstanceOf(
      JournalReversalError
    );
  });

  it('postJournal no admite contra-asientos: se crean con reverseJournal', async () => {
    const { orgId, initiativeId } = await scenario();
    await expect(postJournal(db, { ...donation(orgId, initiativeId), kind: 'REVERSAL' })).rejects.toBeInstanceOf(LedgerValidationError);
  });
});

describe('QA-C03 · saldos reconstruidos solo a partir de los apuntes', () => {
  it('donación + comisión de Paycomet: cada cuenta y cada dimensión cuadra', async () => {
    const { orgId, initiativeId } = await scenario();
    await postJournal(db, donation(orgId, initiativeId));
    await postJournal(db, {
      idempotencyKey: uniqueId('fee'),
      kind: 'GATEWAY_FEE',
      description: 'Comisión de Paycomet (1 % + 0,09 €)',
      organizationId: orgId,
      initiativeId,
      lines: [
        { account: 'GATEWAY_FEES_EXPENSE', direction: 'DEBIT', amountCents: 36, organizationId: orgId },
        { account: 'PSP_CLEARING', direction: 'CREDIT', amountCents: 36, organizationId: orgId }
      ]
    });

    const balances = Object.fromEntries((await getBalancesByAccount(db, { organizationId: orgId })).map((balance) => [balance.account, balance.balanceCents]));
    expect(balances).toEqual({ PSP_CLEARING: 2_644, INITIATIVE_ESCROW: 2_500, KORUM_REVENUE_GUARANTEE: 180, GATEWAY_FEES_EXPENSE: 36 });
    // Activo + gasto = pasivo + ingreso.
    expect(balances.PSP_CLEARING! + balances.GATEWAY_FEES_EXPENSE!).toBe(balances.INITIATIVE_ESCROW! + balances.KORUM_REVENUE_GUARANTEE!);
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId })).balanceCents).toBe(2_500);
    expect((await getAccountBalance(db, 'FAMILY_WALLET', { userId: 'nadie' })).balanceCents).toBe(0);
  });

  it('liquidación de la iniciativa #1 de la semilla (583.300 = 561.000 + 14.440 + 7.860) deja la hucha a cero', async () => {
    const { orgId, initiativeId } = await scenario();
    await postJournal(db, {
      idempotencyKey: uniqueId('payin-total'),
      kind: 'PAYIN_DONATION',
      description: 'Cobros acumulados hasta la meta',
      organizationId: orgId,
      initiativeId,
      lines: [
        { account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: 583_300, organizationId: orgId },
        { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: 583_300, organizationId: orgId, initiativeId }
      ]
    });
    await postJournal(db, {
      idempotencyKey: uniqueId('payout-approval'),
      kind: 'PAYOUT_APPROVAL',
      description: 'Liquidación aprobada con doble firma',
      organizationId: orgId,
      initiativeId,
      lines: [
        { account: 'INITIATIVE_ESCROW', direction: 'DEBIT', amountCents: 583_300, organizationId: orgId, initiativeId },
        { account: 'ORG_PAYABLE', direction: 'CREDIT', amountCents: 561_000, organizationId: orgId },
        { account: 'KORUM_REVENUE_BRACKET', direction: 'CREDIT', amountCents: 14_440, organizationId: orgId },
        { account: 'GATEWAY_FEES_RECOVERED', direction: 'CREDIT', amountCents: 7_860, organizationId: orgId }
      ]
    });
    await postJournal(db, {
      idempotencyKey: uniqueId('split'),
      kind: 'SPLIT_PAYOUT_ORGANIZATION',
      description: 'Split transfer a la cuenta de la entidad',
      organizationId: orgId,
      initiativeId,
      lines: [
        { account: 'ORG_PAYABLE', direction: 'DEBIT', amountCents: 561_000, organizationId: orgId },
        { account: 'PSP_CLEARING', direction: 'CREDIT', amountCents: 561_000, organizationId: orgId }
      ]
    });

    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId })).balanceCents).toBe(0);
    expect((await getAccountBalance(db, 'ORG_PAYABLE', { organizationId: orgId })).balanceCents).toBe(0);
    expect((await getAccountBalance(db, 'KORUM_REVENUE_BRACKET', { organizationId: orgId })).balanceCents).toBe(14_440);
    expect((await getAccountBalance(db, 'PSP_CLEARING', { organizationId: orgId })).balanceCents).toBe(22_300);
  });

  it('el balance de sumas de todo el libro cuadra después de todas las pruebas anteriores', async () => {
    const trial = await getTrialBalance(db);
    expect(trial.debitCents).toBeGreaterThan(0);
    expect(trial.balanced).toBe(true);
  });
});
