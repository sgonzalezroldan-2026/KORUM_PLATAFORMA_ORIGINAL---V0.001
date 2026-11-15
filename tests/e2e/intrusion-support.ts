import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { academicYearFor } from '@/core/finance/academic-year';
import { quarterOf } from '@/core/ideas/idea-conversion';
import { generateTicketCode } from '@/core/support/support-rules';
import { withE2eDb } from './auth-support';
import { E2E_SCHEMA } from './e2e-database';
import type { RegisteredEntity } from './panel-support';

/**
 * Sprint 5.6 · QA-SEC10 · Piezas de la prueba de intrusión entre entidades (`tenant-intrusion.spec.ts`): el censo de acciones de la compilación, cómo se
 * invoca una acción como lo hace el navegador, los datos de la entidad atacada, su huella y lo que queda en la auditoría tras cada intento.
 */

export const MANIFEST = path.join(process.cwd(), '.next', 'server', 'server-reference-manifest.json');

export interface ActionRef {
  id: string;
  file: string;
  name: string;
  /** Páginas desde las que Next admite esta acción (solo se puede invocar en ellas). */
  pages: string[];
}

export function loadActions(): ActionRef[] {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { node: Record<string, { filename: string; exportedName: string; workers: Record<string, unknown> }> };
  return Object.entries(manifest.node)
    .map(([id, entry]) => ({ id, file: entry.filename.replaceAll('\\', '/'), name: entry.exportedName, pages: Object.keys(entry.workers) }))
    .filter((action) => action.file.startsWith('src/app/'));
}

/** Dirección de una página de la aplicación a partir de su entrada en el manifiesto, con los parámetros de quien ataca. */
export function pageUrl(worker: string, params: Record<string, string>): string {
  const segments = worker
    .split('/')
    .slice(2, -1)
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .map((segment) => (/^\[.+\]$/.test(segment) ? (params[segment.slice(1, -1)] ?? '1') : segment));
  return `/${segments.join('/')}`;
}

export interface ActionOutcome {
  http: number;
  /** Lo que devolvió la acción (su fila en la respuesta de React). */
  result: unknown;
  /** La respuesta entera, para comprobar que no trae nada de la otra entidad. */
  body: string;
}

const ACTION_HEADERS = { 'Content-Type': 'text/plain;charset=UTF-8', Accept: 'text/x-component' };

/**
 * Invoca una acción de servidor desde el navegador de quien ataca, con su sesión, como hace el propio cliente de Next. Una respuesta sin resultado legible
 * es un fallo de la prueba: no puede pasar por «no tuvo éxito».
 */
export async function invoke(page: Page, url: string, actionId: string, args: unknown[]): Promise<ActionOutcome> {
  const { http, body } = await page.evaluate(
    async (request) => {
      const response = await fetch(request.url, { method: 'POST', headers: { 'Next-Action': request.actionId, ...request.headers }, body: JSON.stringify(request.args) });
      return { http: response.status, body: await response.text() };
    },
    { url, actionId, args, headers: ACTION_HEADERS }
  );
  const row = /^1:(.*)$/m.exec(body)?.[1];
  if (row === undefined) throw new Error(`La acción ${actionId} en ${url} no devolvió ningún resultado (HTTP ${http}): ${body.slice(0, 300)}`);
  return { http, result: JSON.parse(row) as unknown, body };
}

/** La misma llamada sin sesión y sin seguir redirecciones: se ve el código real de la respuesta y a dónde manda. */
export async function invokeAnonymous(request: APIRequestContext, origin: string, url: string, actionId: string, args: unknown[]): Promise<{ http: number; location: string; body: string }> {
  const response = await request.post(url, { maxRedirects: 0, headers: { 'Next-Action': actionId, ...ACTION_HEADERS, origin, 'sec-fetch-site': 'same-origin' }, data: JSON.stringify(args) });
  return { http: response.status(), location: response.headers()['location'] ?? '', body: await response.text() };
}

export const statusOf = (result: unknown): string => (typeof result === 'object' && result !== null && 'status' in result ? String((result as { status: unknown }).status) : String(result));
export const reasonOf = (result: unknown): string => (typeof result === 'object' && result !== null && 'reason' in result ? String((result as { reason: unknown }).reason) : statusOf(result));

// ───────────── Auditoría ─────────────

export interface AuditRow {
  action: string;
  organizationId: string | null;
  targetType: string;
  metadata: Record<string, unknown>;
}

/** Ejecuta una llamada y devuelve, con su resultado, las filas de auditoría que dejó a nombre de quien ataca. */
export async function audited<T>(actorEmail: string, call: () => Promise<T>): Promise<{ outcome: T; audit: AuditRow[] }> {
  const mark = await withE2eDb((db) => db.query(`SELECT coalesce(max(id), 0)::int AS id FROM "AuditLog"`)).then((result) => Number(result.rows[0].id));
  const outcome = await call();
  const { rows } = await withE2eDb((db) =>
    db.query(
      `SELECT a.action, a."organizationId", a."targetType", coalesce(a."metadataJson", '{}'::jsonb) AS metadata FROM "AuditLog" a JOIN "User" u ON u.id = a."actorUserId" WHERE a.id > $1 AND lower(u.email) = lower($2) ORDER BY a.id`,
      [mark, actorEmail]
    )
  );
  return { outcome, audit: rows as AuditRow[] };
}

// ───────────── La entidad atacada ─────────────

/** Identificadores de recursos que una acción del panel puede recibir. */
export interface Targets {
  campaignId: number;
  draftId: number;
  eventId: number;
  raffleId: number;
  /** Campaña conseguida, con su liquidación pedida. */
  payoutCampaignId: number;
  ideaId: number;
  signatureId: number;
  sponsorId: number;
  fundPayoutId: number;
  handoverId: string;
  gateSessionId: string;
  ticketCode: string;
}

export interface Victim extends Targets {
  organizationId: string;
  documentId: number;
  /** Ficheros privados de B: un documento del titular y la factura de su liquidación. */
  kybFileId: string;
  invoiceFileId: string;
  /** Datos de B que no pueden aparecer en ninguna respuesta a quien ataca. */
  needles: string[];
}

/** Identificadores bien formados que no existen: la respuesta a algo de otra entidad debe ser la misma que a esto. */
export function missingTargets(): Targets {
  const none = 2_147_483_000;
  return { campaignId: none, draftId: none, eventId: none, raffleId: none, payoutCampaignId: none, ideaId: none, signatureId: none, sponsorId: none, fundPayoutId: none, handoverId: 'z'.repeat(24), gateSessionId: randomUUID(), ticketCode: generateTicketCode() };
}

const fileId = () => randomUUID().replace(/-/g, '').slice(0, 24);
const order = (prefix: string) => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`;

/**
 * Datos de la entidad B, de todo lo que una acción del panel puede tocar: campañas en cada estado, un evento con entradas y su sesión de portería, una rifa
 * con su acta, una idea con una firma, un comercio con su cobro y su dinero en el Fondo, una liquidación con factura, otra del Fondo, un relevo de firmante,
 * un documento del titular y una consulta de una familia.
 */
export async function prepareVictim(entity: RegisteredEntity): Promise<Victim> {
  return withE2eDb(async (db) => {
    const organization = (await db.query(`UPDATE "Organization" SET "publicIndexing" = false WHERE slug = $1 RETURNING id, "walletId"`, [entity.slug])).rows[0] as { id: string; walletId: string };
    const organizationId = organization.id;
    const director = (await db.query(`SELECT m.id AS "memberId", m."userId" FROM "OrganizationMember" m WHERE m."organizationId" = $1 AND m.role = 'DIRECTOR'`, [organizationId])).rows[0] as { memberId: number; userId: string };
    const wallets: string[] = [organization.walletId];
    const initiative = async (title: string, status: string, ticket: { subtype: 'EVENT' | 'RAFFLE'; prizes: number | null } | null = null) => {
      const wallet = `WLT-ESC-${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
      wallets.push(wallet);
      const { rows } = await db.query(
        `INSERT INTO "Initiative" ("walletEscrowId", "format", "organizationId", "academicYear", "title", "category", "stage", "status", "stepIndex", "closesAt", "quarter", "goalCents", "description",
           "ticketSubtype", "ticketPriceCents", "ticketMax", "ticketFeeMode", "rafflePrizeCount", "updatedAt")
         VALUES ($1, $2::"InitiativeFormat", $3, $11, $4, 'Fiesta', 'Infantil', $5::"InitiativeStatus", 4, now() + interval '30 days', $12, 50000, 'Datos de la entidad B',
           $6::"TicketSubtype", $7, $8, $9::"TicketFeeMode", $10, now()) RETURNING id`,
        [wallet, ticket ? 'TICKETING' : 'BUDGET', organizationId, title, status, ticket?.subtype ?? null, ticket ? 500 : null, ticket ? 100 : null, ticket ? 'ADD' : null, ticket?.prizes ?? null, academicYearFor(new Date()), quarterOf(new Date(Date.now() + 30 * 86_400_000))]
      );
      return Number(rows[0].id);
    };
    const campaignId = await initiative('Campaña de la entidad B', 'FUNDRAISING');
    const draftId = await initiative('Borrador de la entidad B', 'BUDGETING');
    const payoutCampaignId = await initiative('Campaña conseguida de la entidad B', 'GOAL_REACHED');
    const eventId = await initiative('Fiesta de la entidad B', 'FUNDRAISING', { subtype: 'EVENT', prizes: null });
    const raffleId = await initiative('Rifa de la entidad B', 'FUNDRAISING', { subtype: 'RAFFLE', prizes: 1 });

    // Buzón de ideas: una idea por moderar con una firma en revisión.
    const authorEmail = `autora-${randomUUID().slice(0, 8)}@familias.example`;
    const signerEmail = `firma-b-${randomUUID().slice(0, 8)}@familias.example`;
    const idea = await db.query(
      `INSERT INTO "Idea" ("organizationId", alias, "authorCanonicalEmail", title, category, description, phase, votes, "verifiedVotes", "suspiciousVotes", "expiresAt")
       VALUES ($1, '#FAM-7777', $2, 'Idea de la entidad B', 'Patios y Deporte', 'Una propuesta que solo debe ver la entidad B.', 'PHASE0_MOD'::"IdeaPhase", 1, 1, 0, now() + interval '20 days') RETURNING id`,
      [organizationId, authorEmail]
    );
    const ideaId = Number(idea.rows[0].id);
    const signature = await db.query(`INSERT INTO "IdeaSignatureAudit" ("ideaId", "canonicalEmail", "accountOrder", status, reason) VALUES ($1, $2, 3, 'SUSPICIOUS', 'ideas.audit.tooManyAccounts') RETURNING id`, [ideaId, signerEmail]);

    // Un comercio con su cobro, su dinero en el Fondo de actividades y una liquidación del Fondo pedida.
    const sponsor = await db.query(
      `INSERT INTO "Sponsor" ("organizationId", name, "contactPerson", phone, email, sector, "tierLabel", "amountCents", "feeGeneratedCents", promo, code, "expiresAt")
       VALUES ($1, 'Comercio de la entidad B', 'Persona B', '600000000', 'comercio-b@comercios.example', 'Librería', 'ORO', 50000, 7500, '', $2, now() + interval '300 days') RETURNING id`,
      [organizationId, `B${randomUUID().slice(0, 8).toUpperCase()}`]
    );
    const sponsorId = Number(sponsor.rows[0].id);
    const charge = async (initiativeId: number, type: 'SPONSORSHIP' | 'TICKET', email: string, cents: number, extra: { sponsorId?: number; quantity?: number } = {}) =>
      Number(
        (
          await db.query(
            `INSERT INTO "Contribution" ("organizationId", "initiativeId", "sponsorId", "guestEmail", "canonicalEmail", "fiscalYear", "type", "ticketQuantity", "amountCents", "totalChargedCents", "paymentMethod", "status", "paycometOrder")
             VALUES ($1, $2, $3, $4, $4, 2026, $5::"ContributionType", $6, $7, $7, 'CARD'::"PaymentMethod", 'COMPLETED'::"ContributionStatus", $8) RETURNING id`,
            [organizationId, initiativeId, extra.sponsorId ?? null, email, type, extra.quantity ?? null, cents, order(type === 'TICKET' ? 'KT' : 'KS')]
          )
        ).rows[0].id
      );
    const sponsorCharge = await charge(campaignId, 'SPONSORSHIP', 'comercio-b@comercios.example', 50_000, { sponsorId });
    await db.query(`INSERT INTO "ActivityFundDeposit" ("organizationId", "sponsorId", "contributionId", "amountCents") VALUES ($1, $2, $3, 50000)`, [organizationId, sponsorId, sponsorCharge]);
    const fundPayout = await db.query(`INSERT INTO "ActivityFundPayout" ("organizationId", "amountCents", purpose, "requestedById") VALUES ($1, 50000, 'Material deportivo de la entidad B para todo el curso.', $2) RETURNING id`, [organizationId, director.userId]);
    const fundPayoutId = Number(fundPayout.rows[0].id);
    await db.query(`INSERT INTO "ActivityFundSplit" ("payoutId", "sponsorId", "contributionId", "amountCents") VALUES ($1, $2, $3, 50000)`, [fundPayoutId, sponsorId, sponsorCharge]);

    // Ficheros privados: un documento del titular y la factura de la liquidación pedida de la campaña conseguida.
    const file = async (purpose: 'KYB_DOCUMENT' | 'PROVIDER_INVOICE') =>
      String(
        (
          await db.query(
            `INSERT INTO "FileAsset" ("id", "bucket", "objectKey", "visibility", "purpose", "mimeType", "sizeBytes", "sha256", "organizationId") VALUES ($1, 'private', $2, 'PRIVATE', $3::"FilePurpose", 'application/pdf', 1000, $4, $5) RETURNING id`,
            [fileId(), `intrusion/${randomUUID()}`, purpose, 'b'.repeat(64), organizationId]
          )
        ).rows[0].id
      );
    const kybFileId = await file('KYB_DOCUMENT');
    const invoiceFileId = await file('PROVIDER_INVOICE');
    const document = await db.query(`INSERT INTO "KybDocument" ("organizationId", "kind", "fileId") VALUES ($1, 'STATUTES'::"KybDocumentKind", $2) RETURNING id`, [organizationId, kybFileId]);
    await db.query(
      `INSERT INTO "EscrowPayout" ("organizationId", "initiativeId", "destinationType", "beneficiaryName", "providerInvoiceFileId", "requestedById", "netPaidCents", "korumFeeSettledCents")
       VALUES ($1, $2, 'ORGANIZATION'::"PayoutDestination", 'Titular de la entidad B', $3, $4, 45000, 0)`,
      [organizationId, payoutCampaignId, invoiceFileId, director.userId]
    );

    // Un relevo de firmante propuesto y sin aceptar.
    const handoverId = fileId();
    await db.query(
      `INSERT INTO "SignerHandover" ("id", "organizationId", "role", "outgoingMemberId", "outgoingUserId", "incomingUserId", "roleLabel", "displayName", "proposedByUserId", "status", "expiresAt", "consentedAt")
       VALUES ($1, $2, 'COSIGNER'::"MemberRole", $3, $4, $5, 'Tesorería del AFA', 'Persona Relevo B', $4, 'INVITED'::"SignerHandoverStatus", now() + interval '72 hours', now())`,
      [handoverId, organizationId, director.memberId, director.userId, `entrante-${randomUUID().slice(0, 12)}`]
    );

    // Taquilla: una entrada vendida, una sesión de portería abierta y una rifa sorteada.
    const pass = async (initiativeId: number, subtype: 'EVENT' | 'RAFFLE', numbers: number[]) => {
      const uuid = randomUUID();
      const email = `entrada-b-${uuid.slice(0, 8)}@familias.example`;
      const contributionId = await charge(initiativeId, 'TICKET', email, 1_000, { quantity: 2 });
      const serial = `${subtype === 'RAFFLE' ? 'RIFA' : 'PASE'}-2026-${uuid.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
      const inserted = await db.query(
        `INSERT INTO "TicketPass" ("uuid", "contributionId", "initiativeId", "serialCode", "subtype", "holderEmail", "quantity", "raffleNumbers", "qrHmacSignature") VALUES ($1, $2, $3, $4, $5::"TicketSubtype", $6, 2, $7, $8) RETURNING id`,
        [uuid, contributionId, initiativeId, serial, subtype, email, numbers, 'firma-de-prueba']
      );
      for (const number of numbers) await db.query(`INSERT INTO "RaffleNumber" ("initiativeId", "number", "ticketPassId") VALUES ($1, $2, $3)`, [initiativeId, number, inserted.rows[0].id]);
      return { email, serial };
    };
    const entry = await pass(eventId, 'EVENT', []);
    const paper = await pass(raffleId, 'RAFFLE', [1, 2]);
    const gateSessionId = fileId();
    await db.query(`INSERT INTO "GateSession" ("id", "initiativeId", "tokenHash", "deviceLabel", "expiresAt") VALUES ($1, $2, $3, 'Móvil de la entidad B', now() + interval '8 hours')`, [gateSessionId, eventId, randomUUID().replace(/-/g, '').repeat(2)]);
    await db.query(
      `INSERT INTO "RaffleDraw" ("initiativeId", "round", "idempotencyKey", "participantsJson", "participantsSha256", "winningNumbers", "actSha256", "drawnByType", "drawnById", "drawnAt")
       VALUES ($1, 1, $2, $3::jsonb, $4, '{1}', $5, 'USER', $6, now())`,
      [raffleId, randomUUID(), JSON.stringify([1, 2].map((number) => ({ number, serialCode: paper.serial }))), 'c'.repeat(64), 'd'.repeat(64), director.userId]
    );

    // Una consulta de una familia a la entidad B.
    const ticketCode = generateTicketCode();
    await db.query(
      `INSERT INTO "SupportTicket" ("ticketCode", "organizationId", "target", "originLabel", "senderEmail", "subject", "message", "updatedAt") VALUES ($1, $2, 'ORGANIZATION'::"SupportTarget", 'Familia B', 'familia-b@familias.example', 'Consulta de la entidad B', 'Solo la entidad B debe leer esto.', now())`,
      [ticketCode, organizationId]
    );

    const needles = [entity.name, entity.director, entity.cosigner, 'de la entidad B', 'Persona Relevo B', 'comercio-b@comercios.example', 'familia-b@familias.example', authorEmail, signerEmail, entry.email, paper.email, entry.serial, paper.serial, ticketCode, ...wallets];
    return { organizationId, campaignId, draftId, eventId, raffleId, payoutCampaignId, ideaId, signatureId: Number(signature.rows[0].id), sponsorId, fundPayoutId, handoverId, gateSessionId, ticketCode, documentId: Number(document.rows[0].id), kybFileId, invoiceFileId, needles };
  });
}

/** Datos de B que aparecen en un texto (debe salir vacío para cualquier respuesta a quien ataca). */
export const leaksIn = (body: string, victim: Victim): string[] => victim.needles.filter((needle) => body.includes(needle));

// ───────────── La huella de la entidad atacada ─────────────

/** Tablas que cambian solas (avisos, emails en cola, alertas, tareas): no forman parte de la huella. Los emails se vigilan aparte (`outboxOf`). */
const VOLATILE_TABLES = new Set(['AuditLog', 'OutboxMessage', 'OpsAlert', 'Job']);
/** Columnas que tocan las tareas programadas de otras pruebas (el barrido de IndexNow) o que solo marcan la hora. */
const VOLATILE_COLUMNS = ['updatedAt', 'indexNowStatus'];
/** Columnas con las que cualquier tabla apunta a un recurso de una entidad, y la tabla de ese recurso. */
const REFERENCES: Record<string, string> = { initiativeId: 'Initiative', ideaId: 'Idea', sponsorId: 'Sponsor', payoutId: 'EscrowPayout', fundPayoutId: 'ActivityFundPayout', pollId: 'ResizePoll', ticketPassId: 'TicketPass', contributionId: 'Contribution' };

/**
 * Huella de todo lo que es de una entidad. Si algo cambia, se crea o se borra, la huella cambia:
 *  - su ficha y cada fila de cada tabla con `organizationId`;
 *  - cada fila de CUALQUIER tabla que apunte a uno de sus recursos (campañas, ideas, comercios, liquidaciones, votaciones, pases, cobros), sea cual sea la
 *    entidad que figure en esa fila: una firma o un reparto creados a nombre de otra entidad sobre un recurso suyo también cuentan;
 *  - las cuentas de sus personas firmantes (usuario, contraseña, segundo factor) y sus invitaciones y códigos pendientes.
 */
export async function fingerprint(organizationId: string): Promise<Record<string, string>> {
  return withE2eDb(async (db) => {
    const strip = VOLATILE_COLUMNS.map((column) => ` - '${column}'`).join('');
    const digest = async (table: string, where: string, values: unknown[]) =>
      String((await db.query(`SELECT md5(coalesce(string_agg(md5((to_jsonb(t)${strip})::text), '' ORDER BY md5((to_jsonb(t)${strip})::text)), '')) || ':' || count(*) AS digest FROM "${table}" t WHERE ${where}`, values)).rows[0].digest);
    const result: Record<string, string> = { Organization: await digest('Organization', 't.id = $1', [organizationId]) };

    const scoped = await db.query(`SELECT table_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'organizationId' ORDER BY table_name`, [E2E_SCHEMA]);
    for (const row of scoped.rows) {
      const table = String(row.table_name);
      if (!VOLATILE_TABLES.has(table)) result[table] = await digest(table, 't."organizationId" = $1', [organizationId]);
    }

    const ids: Record<string, number[]> = {};
    for (const table of new Set(Object.values(REFERENCES))) {
      const owned =
        table === 'ResizePoll'
          ? await db.query(`SELECT p.id FROM "ResizePoll" p JOIN "Initiative" i ON i.id = p."initiativeId" WHERE i."organizationId" = $1`, [organizationId])
          : table === 'TicketPass'
            ? await db.query(`SELECT p.id FROM "TicketPass" p JOIN "Initiative" i ON i.id = p."initiativeId" WHERE i."organizationId" = $1`, [organizationId])
            : await db.query(`SELECT id FROM "${table}" WHERE "organizationId" = $1`, [organizationId]);
      ids[table] = owned.rows.map((row) => Number(row.id));
    }
    const pointing = await db.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = ANY($2::text[]) ORDER BY table_name, column_name`, [E2E_SCHEMA, Object.keys(REFERENCES)]);
    for (const row of pointing.rows) {
      const table = String(row.table_name);
      const column = String(row.column_name);
      if (VOLATILE_TABLES.has(table)) continue;
      // `payoutId` es de una liquidación de campaña en todas las tablas menos en los repartos del Fondo.
      const owner = table === 'ActivityFundSplit' && column === 'payoutId' ? 'ActivityFundPayout' : REFERENCES[column]!;
      result[`${table}.${column}`] = await digest(table, `t."${column}" = ANY($1::int[])`, [ids[owner] ?? []]);
    }

    const members = await db.query(`SELECT u.id, u.email FROM "OrganizationMember" m JOIN "User" u ON u.id = m."userId" WHERE m."organizationId" = $1`, [organizationId]);
    const userIds = members.rows.map((row) => String(row.id));
    result['User (firmantes)'] = await digest('User', 't.id = ANY($1::text[])', [userIds]);
    for (const table of ['Account', 'TwoFactor', 'Passkey']) result[`${table} (firmantes)`] = await digest(table, 't."userId" = ANY($1::text[])', [userIds]);
    // Invitaciones y códigos pendientes. Una invitación se guarda como `korum-invite:<cuenta>:<entidad>` y no lleva ningún email (`src/core/onboarding/invitations.ts`):
    // entran las de la entidad (sea de quien sea la cuenta invitada), las de sus firmantes en cualquier otra parte, las filas que guardan su cuenta como valor
    // y los códigos que van por email.
    result['Verification (entidad y firmantes)'] = await digest(
      'Verification',
      't.identifier LIKE $1 OR t.identifier LIKE ANY($2::text[]) OR t.value = ANY($3::text[]) OR t.identifier ILIKE ANY($4::text[]) OR t.value ILIKE ANY($4::text[])',
      [`korum-invite:%:${organizationId}`, userIds.map((userId) => `korum-invite:${userId}:%`), userIds, members.rows.map((row) => `%${String(row.email)}%`)]
    );
    return result;
  });
}

/** Emails en cola que son de la entidad o van a su gente: un ataque que solo enviara mensajes en su nombre (o a sus personas) se vería aquí. */
export async function outboxOf(organizationId: string, addresses: string[]): Promise<number[]> {
  return withE2eDb(async (db) => {
    const { rows } = await db.query(
      `SELECT o.id FROM "OutboxMessage" o
        WHERE o."organizationId" = $1 OR lower(o."toAddress") = ANY($2::text[]) OR o."userId" IN (SELECT m."userId" FROM "OrganizationMember" m WHERE m."organizationId" = $1) ORDER BY o.id`,
      [organizationId, addresses.map((address) => address.toLowerCase())]
    );
    return rows.map((row) => Number(row.id));
  });
}

// ───────────── Argumentos de las acciones del panel ─────────────

const TEXT = 'Texto escrito por la entidad A que no es suyo decidir.';
/** Cierre válido de un borrador del Estudio: 30 días después de hoy (Sprint 5.7: una fecha fija dejaría de ser un borrador bien formado al pasar). */
const closesOnInAMonth = () => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const studioDraft = (initiativeId: number) => ({ initiativeId, format: 'BUDGET', title: 'Título cambiado por la entidad A', category: 'Patios y Deporte', stage: 'Infantil', closesOn: closesOnInAMonth(), description: 'Descripción cambiada por la entidad A', showPublicBreakdown: true, plaqueEnabled: false, rewardEnabled: false, rewardText: null, targetFamiliesPerCourse: 20, costMatCents: 100, costInstCents: 0, contingencyBps: 1000, ticketSubtype: 'EVENT', ticketPriceCents: 500, ticketMax: 200, ticketFeeMode: 'ADD', ticketVenue: null, rafflePrizeCount: null, raffleNoticeConfirmed: false });

/** Acciones del panel que reciben el identificador de un recurso (además de la entidad): sus argumentos bien formados para una entidad y unos recursos dados. */
export function resourceArguments(slug: string, target: Targets): Record<string, unknown[]> {
  return {
    cancelHandoverAction: [slug, target.handoverId],
    resendHandoverAction: [slug, target.handoverId],
    approveIdeaAction: [slug, { ideaId: target.ideaId, title: 'Título cambiado por la entidad A', category: 'Patios y Deporte', description: 'Descripción cambiada por la entidad A para una idea que no es suya.' }],
    rejectIdeaAction: [slug, { ideaId: target.ideaId, reason: TEXT }],
    replyIdeaAction: [slug, { ideaId: target.ideaId, body: TEXT }],
    revalidateSignatureAction: [slug, { ideaId: target.ideaId, signatureId: target.signatureId }],
    requestIdeaSignatureAction: [slug, { ideaId: target.ideaId }],
    approveSponsorAction: [slug, { sponsorId: target.sponsorId }],
    rejectSponsorAction: [slug, { sponsorId: target.sponsorId, reason: TEXT }],
    assignPooledSponsorAction: [slug, { sponsorId: target.sponsorId, initiativeId: target.campaignId }],
    sendSponsorRenewalLinkAction: [slug, { sponsorId: target.sponsorId }],
    saveStudioAction: [slug, studioDraft(target.draftId)],
    publishStudioAction: [slug, { draft: studioDraft(target.draftId), expectedGoalCents: 100 }],
    removeInitiativeCoverAction: [slug, target.campaignId],
    discardStudioAction: [slug, target.draftId],
    requestFundSignatureAction: [slug, { payoutId: target.fundPayoutId }],
    cancelFundPayoutAction: [slug, { payoutId: target.fundPayoutId }],
    retryFundPayoutAction: [slug, { payoutId: target.fundPayoutId }],
    requestPayoutAction: [slug, { destination: 'ORGANIZATION', initiativeId: target.payoutCampaignId, invoiceFileId: null }],
    requestPayoutSignatureAction: [slug, { initiativeId: target.payoutCampaignId }],
    retryPayoutAction: [slug, { initiativeId: target.payoutCampaignId }],
    answerTicketAction: [slug, { ticketCode: target.ticketCode, reply: TEXT, status: 'RESOLVED' }],
    setGatePinAction: [slug, target.eventId],
    rotateGateCodeAction: [slug, target.eventId],
    revokeGateSessionAction: [slug, target.gateSessionId],
    drawExtraRoundAction: [slug, target.raffleId, { reason: 'PRIZE_UNCLAIMED', replacesNumbers: [1], idempotencyKey: randomUUID() }],
    downloadRaffleActAction: [slug, target.raffleId, 1],
    decideRefundAction: [slug, { initiativeId: target.campaignId }],
    launchResizeVoteAction: [slug, { initiativeId: target.campaignId, options: ['Hacer la mitad', 'Hacer un tercio'] }]
  };
}

/** Acciones del panel que solo reciben la entidad (y datos nuevos): sus argumentos bien formados. Las dos de la firma no llevan entidad que valga: dependen del enlace. */
export function entityArguments(slug: string): Record<string, unknown[]> {
  return {
    resendInvitationAction: [slug],
    saveEntitySettingsAction: [slug, { minVotes: 5, defaultContributionCents: 2500 }],
    saveKybIdentityAction: [slug, { cif: 'G12345674', legalName: 'Nombre escrito por la entidad A' }],
    submitKybAction: [slug],
    removeEntityImageAction: [slug, 'logo'],
    saveEntityAccentAction: [slug, { accent: 'navy' }],
    saveParticipationGroupsAction: [slug, { groups: ['Grupo de la entidad A', 'Otro grupo de la entidad A'] }],
    changeSignatureModeAction: [slug, { mode: 'SINGLE' }],
    correctCosignerAction: [slug, { name: 'Persona de la entidad A', email: `intrusa-${randomUUID().slice(0, 8)}@familias.example`, roleLabel: 'Presidencia del AFA' }],
    proposeHandoverAction: [slug, { role: 'COSIGNER', name: 'Persona de la entidad A', email: `intrusa-${randomUUID().slice(0, 8)}@familias.example`, roleLabel: 'Presidencia del AFA' }],
    updateRoleLabelAction: [slug, { roleLabel: 'Cargo escrito por la entidad A' }],
    saveSponsorRenewalRuleAction: [slug, { rule: 'SOONEST' }],
    requestFundPayoutAction: [slug, { purpose: 'Destino escrito por la entidad A para un dinero que no es suyo.' }],
    sendToKorumAction: [slug, 'es', { subject: 'Consulta de prueba de intrusión', message: 'Un mensaje que no debe llegar en nombre de otra entidad.' }],
    previewSignatureAction: [slug, 'A'.repeat(43)],
    completeSignatureAction: [{ orgSlug: slug, token: 'A'.repeat(43), otp: '123456' }]
  };
}

/** Un dato bien formado para cada acción de la consola: así lo que la detiene es la guardia del Super-Admin y no la validación de la forma. */
export function consolePayload(name: string, victim: Victim): unknown {
  const byName: Record<string, unknown> = {
    resolveAlertAction: { alertId: '1' },
    requeueEmailsAction: { alertId: '1' },
    resolveAlertWithNoteAction: { alertId: '1', note: 'Nota escrita por la entidad A para cerrar una alerta de KORUM.' },
    resolveStuckAction: { kind: 'REFUND', contributionId: 1, refunded: true },
    resolveSplitAction: { kind: 'CAMPAIGN', splitId: 1, splitAuthCode: null },
    loadInitiativePopupAction: { initiativeId: victim.campaignId },
    executeSelfBoostAction: { initiativeId: victim.campaignId, expectedAmountCents: 100, publiclyDisclosed: true, acceptLoss: true },
    fixTariffAction: { initiativeId: victim.campaignId },
    saveRulesAction: { rules: { maxCampaignDays: 75 }, expectedVersion: 'una-versión' },
    saveMedalsAction: { medals: [], expectedUpdatedAt: new Date().toISOString() },
    addGlobalCategoryAction: { category: { name: 'Categoría de la entidad A', icon: '🎯', rule: 'EXEMPT' } },
    setGlobalCategoryRuleAction: { category: { name: 'Patios y Deporte', rule: 'EXEMPT' } },
    acknowledgePricingAlertAction: { target: { code: 'BRACKET_CLIFF', fingerprint: 'x', source: 'GLOBAL' }, note: 'Nota escrita por la entidad A.' },
    answerPlatformTicketAction: { ticketCode: victim.ticketCode, reply: 'Respuesta de la entidad A en nombre de KORUM.', status: 'RESOLVED' },
    closeRectificationAction: { requestId: 1, outcome: 'COMPLETED', note: 'Nota escrita por la entidad A.' },
    rectifyNameAction: { requestId: 1, name: 'Nombre cambiado por la entidad A' },
    // Sprint 5.8a: buscar a una persona en la auditoría. Con un email bien formado tampoco pasa, ni dice si existe.
    findAuditPersonAction: { email: 'una-familia-de-b@familias.example' }
  };
  return (
    byName[name] ?? {
      organizationId: victim.organizationId,
      review: { decision: 'VERIFIED', ley49Accredited: true },
      tariffs: { custom: false },
      category: { name: 'Categoría de la entidad A', icon: '🎯', rule: 'EXEMPT' },
      email: { subject: 'Mensaje de la entidad A', body: 'Un mensaje que KORUM no ha escrito.' },
      section: 'hucha',
      values: { mode: 'DISABLED' },
      key: 'paycomet.apiKey',
      value: 'clave-de-la-entidad-a',
      text: 'Texto legal escrito por la entidad A',
      target: 'paycomet'
    }
  );
}
