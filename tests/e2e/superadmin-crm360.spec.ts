import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { withE2eDb } from './auth-support';
import { expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { registerEntityAndEnterPanel, type RegisteredEntity } from './panel-support';

/**
 * Sprint 5.2 · Pop-up ejecutivo, Auto-Impulso y ficha 360º (QA-A02, QA-A03). El Super-Admin abre la ficha de una iniciativa desde las tablas (enlace público,
 * comercios, análisis, Auto-Impulso con la decisión de mostrarlo o no y corrección de tarifas), entra en la ficha 360º de una entidad (titular, KYB, firmas,
 * tarifas, categorías, facturas, 6 fuentes y tabla ordenable), revisa y decide los documentos del titular y vuelve a poner en cola los emails fallidos.
 * El Auto-Impulso se ejecuta sobre una copia de una campaña de la semilla (no sobre la semilla: otras pruebas leen sus cifras).
 */

const server = expect.configure({ timeout: 30_000 });
test.describe.configure({ timeout: 240_000 });

async function enterAsSuperadmin(page: Page, isMobile: boolean): Promise<RegisteredEntity> {
  const entity = await registerEntityAndEnterPanel(page, isMobile);
  await withE2eDb((db) => db.query(`UPDATE "User" SET "isSuperadmin" = true WHERE lower("email") = lower($1)`, [entity.director]));
  return entity;
}

/**
 * Copia de la iniciativa 1 de la semilla como campaña recaudando (faltan 150 €): la copia no tiene cobros ni asientos, así que el Auto-Impulso se prueba
 * entera sin alterar lo que leen las demás pruebas, y **pasa a la entidad recién creada por la propia prueba** (`ownerSlug`): una copia en una entidad de la
 * semilla (Cervantes…) añadiría tarjetas y logros a su portada y comercios con campaña a las pruebas de familias y comercios. Devuelve su identificador,
 * su título (único) y la entidad.
 */
async function cloneCampaign(ownerSlug: string): Promise<{ id: number; title: string; slug: string }> {
  const title = `E2E Auto-Impulso ${randomUUID().slice(0, 8)}`;
  return withE2eDb(async (db) => {
    const columns = (
      await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Initiative' AND column_name NOT IN ('id', 'walletEscrowId', 'gateCode', 'paycometEscrowOrderId')`
      )
    ).rows.map((row) => `"${row.column_name}"`);
    const created = await db.query<{ id: number }>(
      `INSERT INTO "Initiative" ("walletEscrowId", ${columns.join(', ')}) SELECT $1, ${columns.join(', ')} FROM "Initiative" WHERE "id" = 1 RETURNING "id"`,
      [`WLT-ESC-${randomUUID().slice(0, 8).toUpperCase()}`]
    );
    const id = created.rows[0]!.id;
    await db.query(
      `UPDATE "Initiative" SET "title" = $2, "organizationId" = (SELECT "id" FROM "Organization" WHERE "slug" = $3), "status" = 'FUNDRAISING', "goalCents" = 100000, "raisedCents" = 85000, "closesAt" = now() + interval '30 days', "absorbsGatewayCostByKorum" = false, "stepIndex" = 2 WHERE "id" = $1`,
      [id, title, ownerSlug]
    );
    const { rows } = await db.query<{ slug: string }>(`SELECT o."slug" FROM "Organization" o JOIN "Initiative" i ON i."organizationId" = o."id" WHERE i."id" = $1`, [id]);
    return { id, title, slug: rows[0]!.slug };
  });
}

/** Una campaña que a KORUM no le compensa pide aceptar la pérdida antes de poder aportar (el servidor lo vuelve a comprobar). */
async function acceptLossIfAsked(popup: ReturnType<Page['locator']>) {
  const box = popup.getByTestId('boost-accept-loss');
  if ((await box.count()) > 0) await popup.getByText(/Entiendo que perderá ese dinero/).click();
}

async function openPopup(page: Page, title: string) {
  const row = page.getByTestId('bi-global').locator('tbody tr', { hasText: title });
  await server(row).toBeVisible();
  await row.getByTestId('open-popup').click();
  const popup = page.getByTestId('initiative-popup');
  await server(popup.getByRole('heading', { level: 2, name: title })).toBeVisible();
  return popup;
}

test('el pop-up de una iniciativa enseña enlace público, comercios y análisis, ofrece el Auto-Impulso sin gastar nada hasta confirmar y se cierra con Escape', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  const entity = await enterAsSuperadmin(page, isMobile);
  const campaign = await cloneCampaign(entity.slug);
  await page.goto('/admin');
  await server(page.getByTestId('bi-global')).toBeVisible();

  const popup = await openPopup(page, campaign.title);
  await expect(popup.getByTestId('popup-summary')).toContainText('WLT-ESC-');
  await expect(popup.getByTestId('popup-link')).toContainText(`/${campaign.slug}/iniciativas/${campaign.id}`);
  await expect(popup.getByTestId('popup-link').getByRole('link', { name: /Abrir la ficha pública/ })).toHaveAttribute('target', '_blank');
  await expect(popup.getByTestId('popup-sponsors')).toBeVisible();
  await expect(popup.getByTestId('popup-analysis')).toContainText('Falta para llegar al 100 %');

  // Auto-Impulso: la visibilidad parte del ajuste y hay dos pasos; cancelar no gasta nada.
  const boost = popup.getByTestId('boost-panel');
  await expect(boost.getByRole('radio')).toHaveCount(2);
  await expect(boost.getByRole('radio', { name: /Mostrar en público/ })).toBeChecked();
  await acceptLossIfAsked(popup);
  await popup.getByTestId('boost-start').click();
  await expect(popup.getByRole('group', { name: 'Confirma el Auto-Impulso' })).toContainText('No se puede deshacer');
  await popup.getByRole('button', { name: 'Cancelar' }).click();
  await expect(popup.getByTestId('boost-start')).toBeVisible();
  const spent = await withE2eDb((db) => db.query(`SELECT count(*)::int AS n FROM "Contribution" WHERE "initiativeId" = $1 AND "type" = 'SELF_BOOST'`, [campaign.id]));
  expect(spent.rows[0]!.n).toBe(0);

  await expectNoSeriousA11yViolations(page);
  await expectNoHorizontalOverflow(page);
  if (isMobile) {
    const fits = await popup.evaluate((node) => node.getBoundingClientRect().width <= window.innerWidth && node.scrollWidth <= node.clientWidth + 1);
    expect(fits, 'el pop-up cabe en 430 px sin desbordar').toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('initiative-popup')).not.toBeVisible();
  await expect(page.getByTestId('bi-global').locator('tbody tr', { hasText: campaign.title }).getByTestId('open-popup')).toBeFocused();

  // La ficha 360º de una entidad **con** campañas lleva la tabla de iniciativas y su selector «Mostrar»: a 430 px nada se sale de la pantalla (fallo del recorrido manual).
  const orgId = await withE2eDb(async (db) => (await db.query<{ id: string }>(`SELECT "id" FROM "Organization" WHERE "slug" = $1`, [campaign.slug])).rows[0]!.id);
  await page.goto(`/admin/entidades/${orgId}`);
  await server(page.getByTestId('bi-global').locator('tbody tr', { hasText: campaign.title })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test('la campaña con retorno negativo avisa con 🚨 y explica por qué no se toca lo ya publicado', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  await enterAsSuperadmin(page, isMobile);
  await page.goto('/admin');
  const negative = page.getByTestId('bi-global').locator('tbody tr', { has: page.locator('[data-diagnosis="negative"]') }).first();
  await server(negative).toBeVisible();
  await negative.getByTestId('open-popup').click();
  const popup = page.getByTestId('initiative-popup');
  await server(popup.getByTestId('popup-negative')).toContainText('retorno negativo');
  await expect(popup.getByTestId('popup-negative')).toContainText('🚨');
  // No hay Auto-Impulso en una campaña con retorno negativo, y la explicación sale siempre (con o sin botón).
  await expect(popup.getByTestId('boost-panel')).toHaveCount(0);
  await expect(popup.getByTestId('fix-panel')).toContainText(/ya está publicada|No hay tarifas|Sube a los valores globales/);
  await expectNoSeriousA11yViolations(page);
  expect(errors).toEqual([]);
});

test('el Auto-Impulso se ejecuta con su decisión de visibilidad: oculto no sale en la ficha pública; mostrado, sí', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  const entity = await enterAsSuperadmin(page, isMobile);
  const hidden = await cloneCampaign(entity.slug);
  const shown = await cloneCampaign(entity.slug);
  await page.goto('/admin');

  for (const { campaign, show } of [
    { campaign: hidden, show: false },
    { campaign: shown, show: true }
  ]) {
    const popup = await openPopup(page, campaign.title);
    await popup.getByRole('radio', { name: show ? /Mostrar en público/ : /No mostrar en público/ }).check();
    await acceptLossIfAsked(popup);
    await popup.getByTestId('boost-start').click();
    await popup.getByTestId('boost-confirm').click();
    // Si a KORUM no le compensa, salta un segundo mensaje con lo que se pierde.
    if ((await popup.getByTestId('boost-loss-panel').count()) > 0) await popup.getByTestId('boost-loss-confirm').click();
    // El pop-up se recarga con el Auto-Impulso ya aportado y sin el panel de aportar.
    await server(popup.getByTestId('popup-previous-boosts')).toContainText(show ? 'mostrado en público' : 'no mostrado en público');
    await expect(popup.getByTestId('boost-panel')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('initiative-popup')).not.toBeVisible();
  }

  const rows = await withE2eDb((db) =>
    db.query<{ id: number; status: string; raised: number; boosts: number; amount: number; disclosed: boolean; journals: number }>(
      `SELECT i."id", i."status"::text AS status, i."raisedCents" AS raised,
              (SELECT count(*)::int FROM "Contribution" c WHERE c."initiativeId" = i."id" AND c."type" = 'SELF_BOOST') AS boosts,
              (SELECT coalesce(sum(c."amountCents"), 0)::int FROM "Contribution" c WHERE c."initiativeId" = i."id" AND c."type" = 'SELF_BOOST') AS amount,
              (SELECT bool_and(c."publiclyDisclosed") FROM "Contribution" c WHERE c."initiativeId" = i."id" AND c."type" = 'SELF_BOOST') AS disclosed,
              (SELECT count(*)::int FROM "LedgerJournal" j WHERE j."initiativeId" = i."id" AND j."kind" = 'SELF_BOOST_INJECTION') AS journals
         FROM "Initiative" i WHERE i."id" = ANY($1::int[]) ORDER BY i."id"`,
      [[hidden.id, shown.id]]
    )
  );
  const [first, second] = rows.rows;
  expect(first).toMatchObject({ id: hidden.id, status: 'GOAL_REACHED', raised: 100_000, boosts: 1, amount: 15_000, disclosed: false, journals: 1 });
  expect(second).toMatchObject({ id: shown.id, status: 'GOAL_REACHED', raised: 100_000, boosts: 1, amount: 15_000, disclosed: true, journals: 1 });

  // Lo que ve una familia: la meta lograda en los dos casos, y el aviso de que la plataforma ayudó (sin importe) solo si se decidió mostrarlo.
  await page.goto(`/${hidden.slug}/iniciativas/${hidden.id}`);
  await server(page.getByTestId('wallet-escrow-id')).toBeVisible();
  await expect(page.getByTestId('self-boost-note')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('La plataforma KORUM también aportó');
  await page.goto(`/${shown.slug}/iniciativas/${shown.id}`);
  await server(page.getByTestId('self-boost-note')).toContainText('La plataforma KORUM también aportó y ayudó a conseguir el reto.');
  await expect(page.getByTestId('self-boost-note')).not.toContainText('150');
  await expectNoSeriousA11yViolations(page);
  expect(errors).toEqual([]);
});

/** Documentos completos del titular de una entidad y su estado de KYB, directamente en la base de pruebas. */
async function prepareKyb(slug: string, status: 'SUBMITTED' | 'PENDING') {
  await withE2eDb(async (db) => {
    const { rows } = await db.query<{ id: string }>(`SELECT "id" FROM "Organization" WHERE "slug" = $1`, [slug]);
    const organizationId = rows[0]!.id;
    const present = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "KybDocument" WHERE "organizationId" = $1 AND "replacedAt" IS NULL`, [organizationId]);
    if (present.rows[0]!.n === 0) {
      for (const kind of ['TAX_ID_CARD', 'STATUTES', 'REPRESENTATIVE_ID', 'ACCOUNT_OWNERSHIP']) {
        const file = await db.query<{ id: string }>(
          `INSERT INTO "FileAsset" ("id", "bucket", "objectKey", "visibility", "purpose", "mimeType", "sizeBytes", "sha256", "organizationId") VALUES ($1, 'private', $2, 'PRIVATE', 'KYB_DOCUMENT', 'application/pdf', 1000, $3, $4) RETURNING "id"`,
          [randomUUID(), `kyb/${randomUUID()}`, 'a'.repeat(64), organizationId]
        );
        await db.query(`INSERT INTO "KybDocument" ("organizationId", "kind", "fileId") VALUES ($1, $2::"KybDocumentKind", $3)`, [organizationId, kind, file.rows[0]!.id]);
      }
    }
    await db.query(`UPDATE "Organization" SET "kybStatus" = $2::"KybStatus", "kybSubmittedAt" = now(), "cif" = coalesce("cif", $3), "ley49" = false, "kybReviewNote" = NULL WHERE "id" = $1`, [
      organizationId,
      status,
      `G${Math.floor(10_000_000 + Math.random() * 89_999_999)}`
    ]);
  });
}

test('la ficha 360º enseña titular, firmas, tarifas, categorías, facturas y negocio; las tarifas rechazan lo imposible y se guardan', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  const entity = await enterAsSuperadmin(page, isMobile);
  await page.goto('/admin');

  // Desde la tabla de entidades (columna «Gestión»).
  const row = page.getByTestId('bi-orgs').locator('tbody tr', { hasText: entity.name });
  await server(row).toBeVisible();
  await row.getByTestId('open-360').click();
  await server(page).toHaveURL(/\/admin\/entidades\/[^/]+$/);
  await server(page.getByTestId('org-title')).toContainText(entity.name);

  const holder = page.getByTestId('holder-facts');
  await expect(holder).toContainText('AFA CEIP Panel');
  await expect(holder).toContainText('Razón social del titular');
  await expect(holder).toContainText('Cuenta destino en Paycomet');
  // En esta prueba solo ha entrado quien dirige: la cofirma sigue con su invitación sin aceptar y aún no ocupa un puesto.
  await expect(page.getByTestId('seats-list').locator('[data-seat="DIRECTOR"]')).toHaveCount(1);
  await expect(page.getByTestId('seats-list')).toContainText('•••@');
  await expect(page.getByTestId('block-negocio').getByTestId('revenue-sources')).toBeVisible();
  // Una sola tabla de iniciativas (sin el top 10 de la portada).
  await expect(page.getByTestId('bi-top10')).toHaveCount(0);
  await expect(page.getByTestId('block-facturas')).toBeVisible();
  await expect(page.getByTestId('block-categorias').getByTestId('categories-list')).toBeVisible();

  // Tarifas: un decimal de más se rechaza en el campo; con valores válidos se guarda y la ficha lo recuerda.
  const tariffs = page.getByTestId('tariffs-form');
  await expect(page.getByTestId('tariffs-mode')).toContainText('valores globales');
  await tariffs.getByText('Aplicar una tarifa personalizada').click();
  const tramo1 = tariffs.getByLabel(/Tramo 1/);
  await tramo1.fill('4,567');
  await tariffs.getByTestId('tariffs-save').click();
  await expect(tramo1).toHaveAttribute('aria-invalid', 'true');
  await expect(tariffs.getByText('Escribe un número positivo').first()).toBeVisible();
  await tramo1.fill('4,5');
  await tariffs.getByLabel(/Tramo 2/).fill('3,5');
  await tariffs.getByTestId('tariffs-save').click();
  await server(page.getByText('Tarifa personalizada guardada.').first()).toBeVisible();
  await page.reload();
  await server(page.getByTestId('tariffs-mode')).toContainText('tarifas propias');
  await expect(page.getByTestId('tariffs-form').getByLabel(/Tramo 1/)).toHaveValue('4,50');
  // Y vuelve a los valores globales.
  await page.getByText('Aplicar una tarifa personalizada').click();
  await page.getByTestId('tariffs-save').click();
  await server(page.getByText('La entidad vuelve a los valores globales.').first()).toBeVisible();

  // Categorías: una propia nueva aparece en la lista.
  const name = `Huerto ${randomUUID().slice(0, 6)}`;
  await page.getByTestId('category-name').fill(name);
  await expectNoHorizontalOverflow(page);
  await page.getByTestId('category-name').press('Enter');
  await server(page.getByTestId('categories-list').locator(`[data-category="${name}"]`)).toBeVisible();

  // La tabla de iniciativas de la entidad ordena y abre el mismo pop-up que la portada.
  const initiatives = page.getByTestId('bi-global');
  if ((await initiatives.locator('tbody tr').count()) > 0) {
    await initiatives.getByRole('button', { name: /Ordenar por Meta/ }).click();
    await initiatives.getByTestId('open-popup').first().click();
    await server(page.getByTestId('initiative-popup').getByTestId('popup-summary')).toBeVisible();
    await page.keyboard.press('Escape');
  }

  await expectNoSeriousA11yViolations(page);
  await expectNoHorizontalOverflow(page);
  await expectNoMissingTranslations(page);
  expect(errors).toEqual([]);
});

test('la revisión del KYB devuelve con una nota sin datos personales o verifica, y avisa a quienes firman', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  const entity = await enterAsSuperadmin(page, isMobile);
  await prepareKyb(entity.slug, 'SUBMITTED');

  // La entidad aparece en «esperando revisión» con su enlace.
  await page.goto('/admin/entidades');
  const waiting = page.getByTestId('kyb-waiting');
  await server(waiting).toContainText(entity.name);
  await waiting.locator('li', { hasText: entity.name }).getByTestId('review-kyb-link').click();
  await server(page).toHaveURL(/\/admin\/entidades\/[^/]+#kyb$/);

  const kyb = page.getByTestId('block-kyb');
  await expect(kyb.getByTestId('kyb-status')).toHaveAttribute('data-status', 'SUBMITTED');
  // Cada documento se abre en una pestaña nueva con la entidad en la dirección.
  const links = kyb.getByTestId('kyb-documents').getByRole('link');
  await expect(links).toHaveCount(4);
  await expect(links.first()).toHaveAttribute('href', new RegExp(`/api/panel/documentos/\\d+\\?orgSlug=${entity.slug}$`));

  // Devolver: la nota no puede llevar un email.
  await kyb.getByRole('radio', { name: /Devolver los documentos/ }).check();
  await kyb.getByTestId('kyb-note').fill('Escribid a afa@sol.example con el acta');
  await kyb.getByTestId('kyb-submit').click();
  await expect(kyb.getByText(/dato personal/)).toBeVisible();
  await kyb.getByTestId('kyb-note').fill('Falta la página con la firma del acta fundacional');
  await kyb.getByTestId('kyb-submit').click();
  await server(kyb.getByTestId('kyb-status')).toHaveAttribute('data-status', 'REJECTED');
  await expect(kyb).toContainText('Falta la página con la firma del acta fundacional');
  // Los avisos a quienes firman los cubre la prueba de integración: aquí la persona que dirige es además Super-Admin y no recibe avisos de su propia revisión.

  // La entidad corrige y vuelve a enviar: ahora se verifica.
  await prepareKyb(entity.slug, 'SUBMITTED');
  await page.reload();
  await server(page.getByTestId('block-kyb').getByTestId('kyb-status')).toHaveAttribute('data-status', 'SUBMITTED');
  await page.getByTestId('block-kyb').getByTestId('kyb-submit').click();
  await server(page.getByTestId('block-kyb').getByTestId('kyb-status')).toHaveAttribute('data-status', 'VERIFIED');
  await expect(page.getByTestId('kyb-review-form')).toHaveCount(0);
  const verified = await withE2eDb((db) => db.query<{ status: string; reviewed: boolean }>(`SELECT "kybStatus"::text AS status, ("kybReviewedById" IS NOT NULL) AS reviewed FROM "Organization" WHERE "slug" = $1`, [entity.slug]));
  expect(verified.rows[0]).toEqual({ status: 'VERIFIED', reviewed: true });

  await expectNoSeriousA11yViolations(page);
  expect(errors).toEqual([]);
});

test('las alertas de email fallido se vuelven a poner en cola', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  await enterAsSuperadmin(page, isMobile);
  const template = `qa.e2e${Math.floor(Math.random() * 1e6)}`;
  const messageKey = `e2e-${randomUUID()}`;
  await withE2eDb(async (db) => {
    await db.query(`INSERT INTO "OutboxMessage" ("idempotencyKey", "templateKey", "toAddress", "payloadJson", "status", "attempts", "lastError") VALUES ($1, $2, 'destino@familias.example', '{}'::jsonb, 'FAILED', 5, 'Rechazado')`, [messageKey, template]);
    await db.query(`INSERT INTO "OpsAlert" ("id", "type", "severity", "dedupeKey", "detailJson") VALUES ($1, 'EMAIL_DELIVERY_FAILED'::"OpsAlertType", 'WARNING'::"OpsAlertSeverity", $2, '{}'::jsonb)`, [randomUUID(), `email:failed:${template}`]);
  });

  await page.goto('/admin');
  const alerts = page.getByTestId('ops-alerts');
  const requeueButtons = alerts.locator('li[data-alert="EMAIL_DELIVERY_FAILED"]').getByTestId('requeue-emails');
  await server(requeueButtons.first()).toBeVisible();
  // La bandeja es de toda la plataforma y la misma prueba corre a la vez en escritorio y en móvil: otra alerta de emails fallidos puede estar delante. Se pulsa en las
  // que haya hasta que los mensajes de esta prueba vuelven a la cola (lo que importa es el estado en la base, no cuál de las alertas era).
  await expect(async () => {
    await page.goto('/admin');
    const buttons = alerts.locator('li[data-alert="EMAIL_DELIVERY_FAILED"]').getByTestId('requeue-emails');
    const count = await buttons.count();
    for (let index = 0; index < count; index += 1) {
      await alerts.locator('li[data-alert="EMAIL_DELIVERY_FAILED"]').getByTestId('requeue-emails').first().click();
      await page.waitForTimeout(400);
    }
    const status = (await withE2eDb((db) => db.query<{ status: string }>(`SELECT "status"::text AS status FROM "OutboxMessage" WHERE "idempotencyKey" = $1`, [messageKey]))).rows[0]!.status;
    expect(status).toBe('PENDING');
  }).toPass({ timeout: 90_000 });

  expect(errors).toEqual([]);
});

/** Persona con cuenta viva que ocupa un puesto de firma de la entidad (sin pasar por la invitación: lo que se prueba es la ficha, no el alta). */
async function seatPerson(slug: string, role: 'COSIGNER', createdAt: string): Promise<string> {
  const id = `e2e${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const email = `${id}@familias.example`;
  await withE2eDb(async (db) => {
    await db.query(`INSERT INTO "User" ("id", "name", "email", "canonicalEmail", "emailVerified", "updatedAt") VALUES ($1, 'Persona de pruebas', $2, $2, true, now())`, [id, email]);
    await db.query(
      `INSERT INTO "OrganizationMember" ("userId", "organizationId", "role", "roleLabel", "createdAt") VALUES ($1, (SELECT "id" FROM "Organization" WHERE "slug" = $2), $3::"MemberRole", 'Tesorería', $4::timestamp)`,
      [id, slug, role, createdAt]
    );
  });
  return id;
}

test('la ficha 360º solo consulta quién firma y cuántas firmas exige la entidad: sin botones de baja ni de confirmación (decisión del promotor, 2026-11-12)', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  const entity = await enterAsSuperadmin(page, isMobile);
  await seatPerson(entity.slug, 'COSIGNER', '2026-01-10T10:00:00Z');
  const id = await withE2eDb(async (db) => (await db.query<{ id: string }>(`SELECT "id" FROM "Organization" WHERE "slug" = $1`, [entity.slug])).rows[0]!.id);
  await page.goto(`/admin/entidades/${id}`);
  const seats = page.getByTestId('seats-list');
  await server(seats.locator('[data-seat="COSIGNER"]')).toBeVisible();
  await expect(seats.locator('[data-seat="DIRECTOR"]')).toBeVisible();
  await expect(page.getByTestId('signature-mode')).toHaveAttribute('data-mode', 'DOUBLE');
  await expect(page.getByTestId('signature-mode')).toContainText('Doble firma');
  // El Super-Admin no gestiona a quien firma: ni baja, ni confirmación, ni retención de pagos.
  await expect(page.getByTestId('seat-release-open')).toHaveCount(0);
  await expect(page.getByTestId('seat-review')).toHaveCount(0);
  await expect(page.getByText('KORUM no da de baja ni confirma puestos')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectNoSeriousA11yViolations(page);

  // La entidad elige firma única desde su panel: la consola lo refleja.
  await withE2eDb((db) => db.query(`UPDATE "Organization" SET "signatureMode" = 'SINGLE' WHERE "slug" = $1`, [entity.slug]));
  await page.reload();
  await server(page.getByTestId('signature-mode')).toHaveAttribute('data-mode', 'SINGLE');
  await expect(page.getByTestId('signature-mode')).toContainText('Firma única');
  await expectNoSeriousA11yViolations(page);
  expect(errors).toEqual([]);
});

for (const locale of ['ca', 'en'] as const) {
  test(`la ficha 360º, la lista de entidades y el pop-up se ven bien en ${locale}: sin claves sin traducir, accesibles y sin desbordar`, async ({ page, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const entity = await enterAsSuperadmin(page, isMobile);
    await prepareKyb(entity.slug, 'SUBMITTED');
    const { id } = await withE2eDb(async (db) => ({ id: (await db.query<{ id: string }>(`SELECT "id" FROM "Organization" WHERE "slug" = $1`, [entity.slug])).rows[0]!.id }));

    await page.goto(`/${locale}/admin/entidades`);
    await server(page.getByTestId('kyb-waiting')).toContainText(entity.name);
    await expectNoMissingTranslations(page);
    await expectNoSeriousA11yViolations(page);
    await expectNoHorizontalOverflow(page);

    await page.goto(`/${locale}/admin/entidades/${id}`);
    await server(page.getByTestId('org-title')).toContainText(entity.name);
    await expectNoMissingTranslations(page);
    await expectNoSeriousA11yViolations(page);
    await expectNoHorizontalOverflow(page);

    await page.goto(`/${locale}/admin`);
    const campaign = await cloneCampaign(entity.slug);
    await page.reload();
    const popup = await openPopup(page, campaign.title);
    await expect(popup.getByTestId('boost-panel')).toBeVisible();
    await expectNoMissingTranslations(page);
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });
}
