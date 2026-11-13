import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostJournalInput } from '@/core/finance/ledger-accounts';
import { getAccountBalance, IdempotencyConflictError, JournalReversalError, postJournal, reverseJournal } from '@/core/finance/ledger.service';
import { LedgerValidationError } from '@/core/finance/ledger-validation';
import { isRootDb } from '@/lib/db';
import { ImmutableRecordError, type KorumPrismaClient } from '@/lib/prisma';
import { createInitiative, createOrganization, createTestClient, table, TEST_SCHEMA, uniqueId } from './test-database';

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

describe('ataques de la auditoría 1.3 (SET CONSTRAINTS, tablas temporales, search_path)', () => {
  const q = (name: string) => table(name);
  const journalSql = (key: string) => `INSERT INTO ${q('LedgerJournal')} ("idempotencyKey","kind","description") VALUES ('${key}','GATEWAY_FEE','ataque') RETURNING "id"`;

  it('SET CONSTRAINTS ALL IMMEDIATE no permite colar un apunte descuadrado después de comprobar el asiento', async () => {
    const key = uniqueId('attack-immediate');
    await expect(
      db.$transaction(async (tx) => {
        const id = (await tx.$queryRawUnsafe<Array<{ id: number }>>(journalSql(key)))[0]!.id;
        await tx.$executeRawUnsafe(
          `INSERT INTO ${q('EscrowLedgerEntry')} ("journalId","account","direction","amountCents") VALUES (${id},'GATEWAY_FEES_EXPENSE','DEBIT',100),(${id},'PSP_CLEARING','CREDIT',100)`
        );
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        await tx.$executeRawUnsafe(`INSERT INTO ${q('EscrowLedgerEntry')} ("journalId","account","direction","amountCents") VALUES (${id},'PSP_CLEARING','DEBIT',777700)`);
      })
    ).rejects.toThrow(/KORUM_UNBALANCED/);
    expect(await db.ledgerJournal.count({ where: { idempotencyKey: key } })).toBe(0);
  });

  it('una tabla temporal «EscrowLedgerEntry» no engaña a la comprobación de cuadre (asiento de un solo apunte)', async () => {
    const key = uniqueId('attack-temp-entry');
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE "EscrowLedgerEntry" ("journalId" integer, "direction" text, "amountCents" integer, "account" text) ON COMMIT DROP`);
        const id = (await tx.$queryRawUnsafe<Array<{ id: number }>>(journalSql(key)))[0]!.id;
        await tx.$executeRawUnsafe(`INSERT INTO ${q('EscrowLedgerEntry')} ("journalId","account","direction","amountCents") VALUES (${id},'PSP_CLEARING','DEBIT',500000)`);
        // Apuntes falsos y cuadrados en la tabla temporal, que una función sin search_path explícito leería.
        await tx.$executeRawUnsafe(`INSERT INTO pg_temp."EscrowLedgerEntry" VALUES (${id},'DEBIT',500000,'PSP_CLEARING'),(${id},'CREDIT',500000,'PSP_CLEARING')`);
      })
    ).rejects.toThrow(/KORUM_UNBALANCED/);
    expect(await db.ledgerJournal.count({ where: { idempotencyKey: key } })).toBe(0);
  });

  it('una tabla temporal «LedgerJournal» no permite añadir apuntes a un asiento ya cerrado', async () => {
    const { orgId, initiativeId } = await scenario();
    const { journal } = await postJournal(db, payin(orgId, initiativeId));
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE "LedgerJournal" ("id" integer, "postedTxId" bigint) ON COMMIT DROP`);
        await tx.$executeRawUnsafe(`INSERT INTO pg_temp."LedgerJournal" VALUES (${journal.id}, txid_current())`);
        await tx.$executeRawUnsafe(
          `INSERT INTO ${q('EscrowLedgerEntry')} ("journalId","account","direction","amountCents") VALUES (${journal.id},'PSP_CLEARING','DEBIT',100000),(${journal.id},'INITIATIVE_ESCROW','CREDIT',100000)`
        );
      })
    ).rejects.toThrow(/KORUM_IMMUTABLE/);
    expect(await db.escrowLedgerEntry.count({ where: { journalId: journal.id } })).toBe(2);
  });

  it('todas las funciones de los triggers llevan search_path explícito con pg_temp al final', async () => {
    const functions = await db.$queryRawUnsafe<Array<{ proname: string; proconfig: string[] | null }>>(
      `SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '${TEST_SCHEMA}' AND p.proname LIKE 'korum\\_%'`
    );
    expect(functions.length).toBeGreaterThanOrEqual(6);
    for (const fn of functions) {
      const searchPath = fn.proconfig?.find((setting) => setting.startsWith('search_path='));
      expect(searchPath, fn.proname).toMatch(/pg_catalog, pg_temp$/);
    }
  });

  it('los apuntes tienen índice por asiento: los triggers de cuadre y las lecturas no recorren la tabla entera', async () => {
    const indexes = await db.$queryRawUnsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = '${TEST_SCHEMA}' AND tablename = 'EscrowLedgerEntry' AND indexname = 'EscrowLedgerEntry_journalId_idx'`
    );
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.indexdef).toMatch(/\("journalId"\)$/);
  });
});

describe('la auditoría solo admite la anonimización de IP y navegador', () => {
  it('poner a NULL ipHash y userAgent está permitido; cualquier otro cambio, no', async () => {
    const entry = await db.auditLog.create({
      data: { actorType: 'USER', action: 'test.retencion', targetType: 'Test', targetId: uniqueId('t'), ipHash: 'hash-ip', userAgent: 'Chrome/Windows', metadataJson: { dato: 1 } }
    });
    await expect(db.$executeRawUnsafe(`UPDATE ${table('AuditLog')} SET "action" = 'borrado', "ipHash" = NULL, "userAgent" = NULL WHERE "id" = ${entry.id}`)).rejects.toThrow(/KORUM_IMMUTABLE/);
    await expect(db.$executeRawUnsafe(`UPDATE ${table('AuditLog')} SET "ipHash" = 'otro' WHERE "id" = ${entry.id}`)).rejects.toThrow(/KORUM_IMMUTABLE/);
    await expect(db.$executeRawUnsafe(`UPDATE ${table('AuditLog')} SET "metadataJson" = '{}' , "ipHash" = NULL, "userAgent" = NULL WHERE "id" = ${entry.id}`)).rejects.toThrow(/KORUM_IMMUTABLE/);
    await expect(db.$executeRawUnsafe(`DELETE FROM ${table('AuditLog')} WHERE "id" = ${entry.id}`)).rejects.toThrow(/KORUM_IMMUTABLE/);

    await db.$executeRawUnsafe(`UPDATE ${table('AuditLog')} SET "ipHash" = NULL, "userAgent" = NULL WHERE "id" = ${entry.id}`);
    const redacted = await db.auditLog.findUniqueOrThrow({ where: { id: entry.id } });
    expect(redacted).toMatchObject({ ipHash: null, userAgent: null, action: 'test.retencion', metadataJson: { dato: 1 } });
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

  it('el cliente de una transacción no se confunde con el raíz (Prisma 7 le deja $transaction, pero no $disconnect)', async () => {
    expect(isRootDb(db)).toBe(true);
    expect(await db.$transaction(async (tx) => isRootDb(tx))).toBe(false);
  });

  it('más transacciones que conexiones y varias rondas: las perdedoras fallan siempre con P2002 (nunca «transacción abortada», P2039) y la conexión queda limpia', async () => {
    const { orgId, initiativeId } = await scenario();
    for (let round = 0; round < 4; round += 1) {
      const input = payin(orgId, initiativeId);
      const results = await Promise.allSettled(Array.from({ length: 14 }, () => db.$transaction((tx) => postJournal(tx, input))));
      expect(results.filter((result) => result.status === 'fulfilled' && result.value.created)).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') expect((result.reason as { code?: string }).code).toBe('P2002');
      }
      expect(await db.ledgerJournal.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(1);
    }
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
