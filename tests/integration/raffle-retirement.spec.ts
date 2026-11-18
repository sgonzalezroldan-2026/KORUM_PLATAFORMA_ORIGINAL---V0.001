import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

/**
 * QA-RET01 · Retirada de las rifas (Sprint 5.12a). La migración `20261127090000_retire_raffles` se aplica sobre una base que **ya tiene una rifa** a medias
 * (vendida, numerada, sorteada, con su ajuste del plazo de reclamación y un aviso de ronda extra en la bandeja de salida), como una base de demostración
 * sembrada antes de este sprint. Esquema propio, que se borra al terminar: las demás pruebas usan `korum_test` con todas las migraciones aplicadas.
 */

const SCHEMA = 'korum_retire_raffles';
const MIGRATIONS = path.join(process.cwd(), 'prisma', 'migrations');
const RETIREMENT = '20261127090000_retire_raffles';

let client: pg.Client;

const migrationDirs = () => readdirSync(MIGRATIONS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const runMigration = (name: string) => client.query(readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await client.query<T>(sql, params)).rows[0];

beforeAll(async () => {
  client = new pg.Client({ connectionString: inject('testDatabaseUrl') });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${SCHEMA}"`);
  await client.query(`SET search_path TO "${SCHEMA}"`);
  const before = migrationDirs().filter((name) => name < RETIREMENT);
  expect(before.length).toBeGreaterThan(30);
  for (const name of before) await runMigration(name);

  // Una entidad con la categoría antigua, propia y de la plataforma.
  await client.query(`INSERT INTO "Organization" ("id", "slug", "name", "legalName", "legalForm", "province", "walletId", "updatedAt")
    VALUES ('org-rifa', 'org-rifa', 'CEIP Rifa', 'AFA CEIP Rifa', 'PARENTS_ASSOCIATION', 'Barcelona', 'WLT-ORG-RIFA', now()),
           ('org-propia', 'org-propia', 'CEIP Propia', 'AFA CEIP Propia', 'PARENTS_ASSOCIATION', 'Barcelona', 'WLT-ORG-PROPIA', now())`);
  // Una «Taquilla» global que el Super-Admin creó como categoría de mejora, y otra propia de una entidad, con una campaña de presupuesto que la usa.
  await client.query(`INSERT INTO "GlobalCategory" ("name", "rule", "sortOrder") VALUES ('Taquilla y Rifas', 'EXEMPT', 6), ('Taquilla', 'BRACKETS', 7)`);
  await client.query(`INSERT INTO "OrganizationCategory" ("organizationId", "name", "rule", "isCustom") VALUES
    ('org-rifa', 'Taquilla y Rifas', 'EXEMPT', false),
    ('org-propia', 'Taquilla y Rifas', 'EXEMPT', false),
    ('org-propia', 'Taquilla', 'BRACKETS', true)`);
  await client.query(`INSERT INTO "Initiative" ("walletEscrowId", "format", "organizationId", "academicYear", "title", "category", "stage", "closesAt", "quarter", "goalCents", "description", "updatedAt")
    VALUES ('WLT-ESC-PROPIA', 'BUDGET', 'org-propia', '2026-2027', 'Mostrador nuevo', 'Taquilla', 'Todo el centro', now(), '2026-Q4', 50000, 'Una mejora de la entidad', now())`);

  // La rifa: publicada, con dos papeletas vendidas y ya sorteada.
  const initiative = await one<{ id: number }>(`INSERT INTO "Initiative" ("walletEscrowId", "format", "organizationId", "academicYear", "title", "category", "stage", "status", "closesAt", "quarter", "goalCents",
      "description", "ticketSubtype", "ticketPriceCents", "ticketMax", "ticketsSold", "ticketFeeMode", "rafflePrizeCount", "updatedAt")
    VALUES ('WLT-ESC-RIFA', 'TICKETING', 'org-rifa', '2026-2027', 'Rifa de demostración', 'Taquilla y Rifas', 'Todo el centro', 'GOAL_REACHED', now(), '2026-Q4', 400,
      'Demostración', 'RAFFLE', 200, 2, 2, 'ADD', 1, now()) RETURNING "id"`);
  const initiativeId = initiative!.id;
  const contribution = await one<{ id: number }>(`INSERT INTO "Contribution" ("organizationId", "initiativeId", "fiscalYear", "type", "ticketQuantity", "amountCents", "totalChargedCents", "paymentMethod", "status", "guestEmail")
    VALUES ('org-rifa', $1, 2026, 'TICKET', 2, 400, 510, 'CARD', 'COMPLETED', 'familia@pruebas.example') RETURNING "id"`, [initiativeId]);
  const pass = await one<{ id: number }>(`INSERT INTO "TicketPass" ("uuid", "contributionId", "initiativeId", "serialCode", "subtype", "holderEmail", "quantity", "raffleNumbers", "qrHmacSignature", "isWinner")
    VALUES ('7d0f5a3e-0000-4000-8000-000000000001', $1, $2, 'RIFA-2026-000777', 'RAFFLE', 'familia@pruebas.example', 2, ARRAY[1, 2], 'firma', true) RETURNING "id"`, [contribution!.id, initiativeId]);
  await client.query(`INSERT INTO "RaffleNumber" ("initiativeId", "number", "ticketPassId") VALUES ($1, 1, $2), ($1, 2, $2)`, [initiativeId, pass!.id]);
  await client.query(`INSERT INTO "RaffleDraw" ("initiativeId", "round", "idempotencyKey", "participantsJson", "participantsSha256", "winningNumbers", "actSha256", "drawnByType", "drawnById", "drawnAt")
    VALUES ($1, 1, 'ronda-1', '[]', 'huella', ARRAY[2], 'acta', 'GATE', 'sesion', now())`, [initiativeId]);
  await client.query(`INSERT INTO "PlatformSetting" ("key", "valueJson", "updatedAt") VALUES ('raffle.extraRoundMinHours', '24', now()), ('hucha.mode', '"PLEDGE"', now())`);
  await client.query(`INSERT INTO "OutboxMessage" ("idempotencyKey", "templateKey", "toAddress", "payloadJson") VALUES
    ('raffle.extraRound:prueba', 'raffle.extraRound', 'firma@pruebas.example', '{"by": "Nombre de quien firma", "byUserId": "user-1"}'),
    ('ticket.pass:pendiente', 'ticket.pass', 'familia@pruebas.example', '{"serialCode": "RIFA-2026-000777", "raffleNumbers": [1, 2], "quantity": 2}')`);
  await client.query(`INSERT INTO "OutboxMessage" ("idempotencyKey", "templateKey", "toAddress", "payloadJson", "status") VALUES
    ('ticket.pass:enviado', 'ticket.pass', 'otra@pruebas.example', '{"serialCode": "RIFA-2026-000776", "raffleNumbers": [3]}', 'SENT')`);

  await runMigration(RETIREMENT);
}, 180_000);

afterAll(async () => {
  await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await client.end();
});

describe('QA-RET01 · la retirada de las rifas se aplica sobre una base con una rifa', () => {
  it('quita las tablas, columnas y guardas de las rifas', async () => {
    const tables = await client.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('RaffleDraw', 'RaffleNumber')`, [SCHEMA]);
    expect(tables.rows).toEqual([]);
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND ((table_name = 'Initiative' AND column_name = 'rafflePrizeCount') OR (table_name = 'TicketPass' AND column_name IN ('raffleNumbers', 'isWinner')))`,
      [SCHEMA]
    );
    expect(columns.rows).toEqual([]);
    const triggers = await client.query<{ tgname: string }>(`SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND t.tgname IN ('RaffleDraw_immutable', 'RaffleDraw_no_truncate', 'Initiative_prize_count_locked')`, [SCHEMA]);
    expect(triggers.rows).toEqual([]);
    const enumValues = await client.query<{ enumlabel: string }>(`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = 'TicketSubtype' ORDER BY e.enumsortorder`, [SCHEMA]);
    expect(enumValues.rows.map((row) => row.enumlabel)).toEqual(['EVENT']);
  });

  it('las guardas del libro mayor, de la auditoría, del aforo y de la votación siguen en su sitio', async () => {
    const guards = ['LedgerJournal_immutable', 'EscrowLedgerEntry_immutable', 'AuditLog_immutable', 'LedgerJournal_no_truncate', 'EscrowLedgerEntry_no_truncate', 'AuditLog_no_truncate', 'LedgerJournal_balanced', 'EscrowLedgerEntry_balanced', 'LedgerJournal_stamp_tx', 'EscrowLedgerEntry_same_transaction', 'ResizePoll_keep_history', 'ResizeVote_keep_history'];
    const found = await client.query<{ tgname: string }>(`SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND t.tgname = ANY($2)`, [SCHEMA, guards]);
    expect(new Set(found.rows.map((row) => row.tgname))).toEqual(new Set(guards));
    const checks = await client.query<{ conname: string }>(`SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND c.conname IN ('EscrowLedgerEntry_amountCents_positive', 'Initiative_tickets_within_capacity')`, [SCHEMA]);
    expect(new Set(checks.rows.map((row) => row.conname))).toEqual(new Set(['EscrowLedgerEntry_amountCents_positive', 'Initiative_tickets_within_capacity']));
    // El aforo sigue sin poder superarse.
    await expect(client.query(`UPDATE "Initiative" SET "ticketsSold" = 3 WHERE "walletEscrowId" = 'WLT-ESC-RIFA'`)).rejects.toThrow();
  });

  it('la rifa que ya existía pasa a ser un evento con entradas, con su cobro y su pase intactos', async () => {
    const initiative = await one<{ id: number; ticketSubtype: string; ticketsSold: number; status: string; category: string }>(`SELECT "id", "ticketSubtype"::text AS "ticketSubtype", "ticketsSold", "status"::text AS "status", "category" FROM "Initiative" WHERE "walletEscrowId" = 'WLT-ESC-RIFA'`);
    expect(initiative).toMatchObject({ ticketSubtype: 'EVENT', ticketsSold: 2, status: 'GOAL_REACHED', category: 'Taquilla' });
    const pass = await one<{ subtype: string; serialCode: string; quantity: number; uuid: string }>(`SELECT "subtype"::text AS "subtype", "serialCode", "quantity", "uuid" FROM "TicketPass" WHERE "initiativeId" = $1`, [initiative!.id]);
    expect(pass).toEqual({ subtype: 'EVENT', serialCode: 'PASE-2026-000777', quantity: 2, uuid: '7d0f5a3e-0000-4000-8000-000000000001' });
    const contribution = await one<{ status: string; totalChargedCents: number }>(`SELECT "status"::text AS "status", "totalChargedCents" FROM "Contribution" WHERE "initiativeId" = $1`, [initiative!.id]);
    expect(contribution).toEqual({ status: 'COMPLETED', totalChargedCents: 510 });
    // Un pase nuevo nace como entrada.
    const defaults = await one<{ column_default: string }>(`SELECT column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'TicketPass' AND column_name = 'subtype'`, [SCHEMA]);
    expect(defaults?.column_default).toContain('EVENT');
  });

  it('la categoría fija pasa a «Taquilla» con su regla, y una «Taquilla» que ya existía pasa a «Taquilla (propia)» con la suya y con sus campañas', async () => {
    const global = await client.query<{ name: string; rule: string }>(`SELECT "name", "rule"::text AS "rule" FROM "GlobalCategory" ORDER BY "name"`);
    expect(global.rows).toEqual([
      { name: 'Taquilla', rule: 'EXEMPT' },
      { name: 'Taquilla (propia)', rule: 'BRACKETS' }
    ]);
    const own = await client.query<{ organizationId: string; name: string; rule: string; isCustom: boolean }>(`SELECT "organizationId", "name", "rule"::text AS "rule", "isCustom" FROM "OrganizationCategory" ORDER BY "organizationId", "name"`);
    expect(own.rows).toEqual([
      { organizationId: 'org-propia', name: 'Taquilla', rule: 'EXEMPT', isCustom: false },
      { organizationId: 'org-propia', name: 'Taquilla (propia)', rule: 'BRACKETS', isCustom: true },
      { organizationId: 'org-rifa', name: 'Taquilla', rule: 'EXEMPT', isCustom: false }
    ]);
    const budget = await one<{ category: string; format: string }>(`SELECT "category", "format"::text AS "format" FROM "Initiative" WHERE "walletEscrowId" = 'WLT-ESC-PROPIA'`);
    expect(budget).toEqual({ category: 'Taquilla (propia)', format: 'BUDGET' });
  });

  it('el email de un pase que aún no ha salido lleva la serie nueva y ya no lleva números; el ya enviado queda como se envió', async () => {
    const pending = await one<{ payloadJson: Record<string, unknown> }>(`SELECT "payloadJson" FROM "OutboxMessage" WHERE "idempotencyKey" = 'ticket.pass:pendiente'`);
    expect(pending!.payloadJson).toEqual({ serialCode: 'PASE-2026-000777', quantity: 2 });
    const sent = await one<{ payloadJson: Record<string, unknown> }>(`SELECT "payloadJson" FROM "OutboxMessage" WHERE "idempotencyKey" = 'ticket.pass:enviado'`);
    expect(sent!.payloadJson).toEqual({ serialCode: 'RIFA-2026-000776', raffleNumbers: [3] });
  });

  it('se van el plazo de reclamación de un premio y los avisos de ronda extra, con el nombre de quien la hizo; lo demás se queda', async () => {
    const settings = await client.query<{ key: string }>(`SELECT "key" FROM "PlatformSetting" ORDER BY "key"`);
    expect(settings.rows.map((row) => row.key)).toEqual(['hucha.mode']);
    const outbox = await client.query<{ templateKey: string }>(`SELECT "templateKey" FROM "OutboxMessage" ORDER BY "templateKey"`);
    expect(outbox.rows.map((row) => row.templateKey)).toEqual(['ticket.pass', 'ticket.pass']);
  });
});

describe('QA-RET01 · la retirada se detiene antes que mezclar dos categorías', () => {
  const CLASH = 'korum_retire_raffles_clash';

  it('con una «Taquilla» propia de una entidad y una «Taquilla (propia)» global, la migración falla entera y no deja nada a medias', async () => {
    const other = new pg.Client({ connectionString: inject('testDatabaseUrl') });
    await other.connect();
    try {
      await other.query(`DROP SCHEMA IF EXISTS "${CLASH}" CASCADE`);
      await other.query(`CREATE SCHEMA "${CLASH}"`);
      await other.query(`SET search_path TO "${CLASH}"`);
      for (const name of migrationDirs().filter((dir) => dir < RETIREMENT)) await other.query(readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
      await other.query(`INSERT INTO "Organization" ("id", "slug", "name", "legalName", "legalForm", "province", "walletId", "updatedAt")
        VALUES ('org-choque', 'org-choque', 'CEIP Choque', 'AFA CEIP Choque', 'PARENTS_ASSOCIATION', 'Barcelona', 'WLT-ORG-CHOQUE', now())`);
      await other.query(`INSERT INTO "GlobalCategory" ("name", "rule", "sortOrder") VALUES ('Taquilla y Rifas', 'EXEMPT', 6), ('Taquilla (propia)', 'BRACKETS', 7)`);
      await other.query(`INSERT INTO "OrganizationCategory" ("organizationId", "name", "rule", "isCustom") VALUES ('org-choque', 'Taquilla', 'BRACKETS', true)`);

      await expect(other.query(readFileSync(path.join(MIGRATIONS, RETIREMENT, 'migration.sql'), 'utf8'))).rejects.toThrow(/KORUM_RETIRE_RAFFLES/);
      // La migración va en una sola transacción: no se ha quitado nada ni renombrado nada.
      const tables = await other.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('RaffleDraw', 'RaffleNumber') ORDER BY 1`, [CLASH]);
      expect(tables.rows.map((row) => row.table_name)).toEqual(['RaffleDraw', 'RaffleNumber']);
      const names = await other.query(`SELECT "name" FROM "GlobalCategory" UNION ALL SELECT "name" FROM "OrganizationCategory" ORDER BY 1`);
      expect(names.rows.map((row) => row.name)).toEqual(['Taquilla', 'Taquilla (propia)', 'Taquilla y Rifas']);
    } finally {
      await other.query(`DROP SCHEMA IF EXISTS "${CLASH}" CASCADE`);
      await other.end();
    }
  }, 180_000);
});
