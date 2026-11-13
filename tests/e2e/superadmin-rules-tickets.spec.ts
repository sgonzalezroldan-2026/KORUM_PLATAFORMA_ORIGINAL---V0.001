import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { emailTo, withE2eDb } from './auth-support';
import { expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { registerEntityAndEnterPanel, type RegisteredEntity } from './panel-support';

/**
 * Sprint 5.3 · Motor de reglas globales, medallas, categorías, avisos de precios, bandeja de soporte de KORUM, email directo y dinero que se resuelve con Paycomet
 * (QA-A03, QA-A04). La configuración global y los ajustes los comparten **todas** las pruebas (y el proyecto de escritorio y el móvil corren a la vez), así que lo que
 * cambia datos compartidos solo se ejecuta en escritorio, toca un valor que ninguna otra prueba lee (`t3Bps`, el tramo de más de 15.000 €) y lo deja como estaba.
 * El móvil recorre las mismas pantallas, sus validaciones y la accesibilidad sin guardar reglas.
 */

const server = expect.configure({ timeout: 30_000 });
test.describe.configure({ timeout: 240_000 });

const TICKET_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newTicketCode = () => `TCK-${Array.from({ length: 6 }, () => TICKET_ALPHABET[Math.floor(Math.random() * TICKET_ALPHABET.length)]).join('')}`;

async function enterAsSuperadmin(page: Page, isMobile: boolean): Promise<RegisteredEntity> {
  const entity = await registerEntityAndEnterPanel(page, isMobile);
  await withE2eDb((db) => db.query(`UPDATE "User" SET "isSuperadmin" = true WHERE lower("email") = lower($1)`, [entity.director]));
  return entity;
}

const hucha = (page: Page) => page.getByTestId('block-pasarela').locator('[data-pricing-alert="HUCHA_FEE_BELOW_GATEWAY_COST"]');

test('el motor de reglas enseña los avisos con su cifra junto a cada campo, los recalcula al escribir y marca lo imposible; accesible, sin desbordes y en catalán', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  await enterAsSuperadmin(page, isMobile);
  await page.goto('/admin');
  await server(page.getByTestId('nav-rules')).toBeVisible();
  await page.getByTestId('nav-rules').click();
  await server(page).toHaveURL(/\/admin\/reglas$/);
  await server(page.getByRole('heading', { level: 1, name: 'Reglas y precios' })).toBeVisible();

  // Con los valores por defecto saltan la Hucha y el escalón, cada uno junto a sus campos y con su cifra; y las entradas dan margen positivo.
  await expect(hucha(page)).toContainText('Un cargo de 50,00 € en Mi Hucha cuesta 0,59 € de pasarela y cobras 0,25 €');
  await expect(page.getByTestId('block-tramos').locator('[data-pricing-alert="BRACKET_CLIFF"]')).toContainText('Considera el modo marginal');
  await expect(page.getByTestId('ticket-margin-ok')).toContainText('+0,40 € por entrada');
  for (const id of ['block-pasarela', 'block-tramos', 'block-garantia', 'block-mantenimiento', 'block-duracion', 'block-medallas', 'block-categorias', 'block-campanas-exentas']) await expect(page.getByTestId(id)).toBeVisible();

  // «Ajustar» lleva el foco al campo implicado y el aviso se recalcula mientras se escribe.
  await hucha(page).getByTestId('pricing-adjust').click();
  const fee = page.getByLabel(/Comisión de Mi Hucha: fijo por cargo/);
  await expect(fee).toBeFocused();
  await fee.fill('2');
  await expect(hucha(page)).toHaveCount(0);
  await fee.fill('0,25');
  await expect(hucha(page)).toBeVisible();

  // Gastos de gestión que no cubren la pasarela: aviso con su cifra y desaparece el «✔️».
  await page.getByLabel(/Gastos de gestión digital: fijo por entrada/).fill('0');
  await page.getByLabel(/Gastos de gestión digital: % sobre el precio/).fill('0');
  await expect(page.getByTestId('ticket-margin-ok')).toHaveCount(0);
  await expect(page.getByTestId('block-pasarela').locator('[data-pricing-alert="TICKET_FEE_BELOW_GATEWAY_COST"]')).toContainText('pierdes');
  await page.reload();

  // Lo imposible se marca en el campo con su texto, el foco va al primero y no se guarda nada.
  const tramo1 = page.getByLabel(/Comisión del tramo 1/);
  await tramo1.fill('4,567');
  await page.getByLabel(/Duración máxima de una campaña/).fill('76');
  await page.getByTestId('rules-save').click();
  await expect(tramo1).toHaveAttribute('aria-invalid', 'true');
  await expect(tramo1).toBeFocused();
  await expect(page.getByText('Hay 2 campos con un valor no válido: corrígelos para guardar.')).toBeVisible();
  await expect(page.getByText('Escribe un número entero de días, de 1 a 75.')).toBeVisible();
  await page.reload();

  await expectNoSeriousA11yViolations(page);
  await expectNoHorizontalOverflow(page);
  await expectNoMissingTranslations(page);

  await page.goto('/ca/admin/reglas');
  await server(page.getByRole('heading', { level: 1, name: 'Regles i preus' })).toBeVisible();
  await expect(page.getByTestId('block-pasarela')).toContainText('Passarel·la, Guardiola i despeses de gestió digital');
  await expectNoSeriousA11yViolations(page);
  await expectNoMissingTranslations(page);
  await page.goto('/en/admin/reglas');
  await server(page.getByRole('heading', { level: 1, name: 'Rules and prices' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await expectNoMissingTranslations(page);
  expect(errors).toEqual([]);
});

test('guardar las reglas lo anuncia, lo recuerda y llega a las entidades sin tarifa propia; aceptar un aviso exige una nota y lo deja atenuado', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Cambia datos compartidos por todas las pruebas: solo en escritorio.');
  const errors = trackConsoleErrors(page);
  const entity = await enterAsSuperadmin(page, isMobile);
  const original = await withE2eDb(async (db) => (await db.query<{ t3Bps: number }>(`SELECT "t3Bps" FROM "GlobalConfig" WHERE "id" = 'GLOBAL'`)).rows[0]!.t3Bps);
  try {
    await page.goto('/admin/reglas');
    const tramo3 = page.getByLabel(/Comisión del tramo 3/);
    await server(tramo3).toHaveValue(String(original / 100).replace('.', ','));
    await tramo3.fill('3,5');
    await page.getByTestId('rules-save').click();
    await server(page.getByText(/Reglas guardadas\. Aplicadas a \d+ entidades? sin tarifa propia/).first()).toBeVisible();
    await page.reload();
    await expect(page.getByLabel(/Comisión del tramo 3/)).toHaveValue('3,50');
    // La entidad sin tarifa propia que acaba de darse de alta ya tiene la copia nueva.
    const copied = await withE2eDb(async (db) => (await db.query<{ t3Bps: number }>(`SELECT "t3Bps" FROM "Organization" WHERE "slug" = $1`, [entity.slug])).rows[0]!.t3Bps);
    expect(copied).toBe(350);
    const audit = await withE2eDb((db) => db.query(`SELECT 1 FROM "AuditLog" WHERE "action" = 'rules.global_updated' AND "metadataJson"->'changes'->'t3Bps'->>'to' = '350'`));
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);

    // Aceptar y registrar: nota obligatoria, y el aviso queda atenuado con su nota (se acepta el del escalón: no es crítico).
    const cliff = page.getByTestId('block-tramos').locator('[data-pricing-alert="BRACKET_CLIFF"]');
    await server(cliff).toBeVisible();
    await cliff.getByTestId('pricing-accept').click();
    await expect(cliff.getByTestId('pricing-note')).toBeFocused();
    await cliff.getByTestId('pricing-note').fill('corta');
    await cliff.getByTestId('pricing-accept-submit').click();
    await expect(cliff.getByRole('alert')).toContainText('al menos 10 caracteres');
    await cliff.getByTestId('pricing-note').fill('Asumimos el escalón mientras decidimos el modo marginal.');
    await cliff.getByTestId('pricing-accept-submit').click();
    await server(page.getByText('Aviso aceptado y registrado.').first()).toBeVisible();
    const accepted = page.getByTestId('block-tramos').locator('[data-pricing-alert="BRACKET_CLIFF"]');
    await expect(accepted).toHaveAttribute('data-accepted', 'true');
    await expect(accepted).toContainText('Asumimos el escalón');
    await expect(accepted.getByTestId('pricing-accept')).toHaveCount(0);
    await expectNoSeriousA11yViolations(page);
    await expectNoMissingTranslations(page);
  } finally {
    // Se devuelve todo a como estaba: las demás pruebas leen los valores por defecto y los avisos sin aceptar.
    await withE2eDb(async (db) => {
      await db.query(`UPDATE "GlobalConfig" SET "t3Bps" = $1 WHERE "id" = 'GLOBAL'`, [original]);
      await db.query(`UPDATE "Organization" SET "t3Bps" = $1 WHERE "customRules" = false`, [original]);
      await db.query(`DELETE FROM "PlatformSetting" WHERE "key" = 'pricing.acknowledgements'`);
    });
  }
  expect(errors).toEqual([]);
});

test('las medallas piden niveles que suben y las categorías globales piden confirmar el cambio de regla', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  await enterAsSuperadmin(page, isMobile);
  await page.goto('/admin/reglas');
  await server(page.getByTestId('medals-form')).toBeVisible();

  // Un oro que no pide más campañas que la plata no sale al servidor: se explica y el foco no se pierde.
  const gold = page.getByLabel('Campañas necesarias').nth(2);
  const original = await gold.inputValue();
  await gold.fill('1');
  await page.getByTestId('medals-save').click();
  await expect(page.getByText(/Cada medalla debe pedir más campañas que la anterior/)).toBeVisible();
  const grant = page.getByLabel(/Beca de ampliación del exento/).first();
  await grant.fill('12,345');
  await page.getByTestId('medals-save').click();
  await expect(grant).toHaveAttribute('aria-invalid', 'true');
  await expect(grant).toBeFocused();
  await page.reload();
  await expect(page.getByLabel('Campañas necesarias').nth(2)).toHaveValue(original);

  // Categorías: una nueva aparece en la lista y cambiar su regla pide confirmar (Escape cancela y devuelve el foco).
  const name = `Huerto ${randomUUID().slice(0, 6)}`;
  try {
    await page.getByTestId('category-new-name').fill(name);
    await page.getByTestId('category-add').click();
    await server(page.getByTestId('global-categories').getByText(name)).toBeVisible();
    const row = page.getByTestId('global-categories').locator('li', { hasText: name });
    const select = row.getByRole('combobox');
    await select.selectOption('EXEMPT');
    const confirm = page.getByTestId('global-category-confirm');
    await expect(confirm).toContainText(`«${name}» pasará a estar exenta (0 %)`);
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(select).toBeFocused();
    await expect(select).toHaveValue('BRACKETS');
    await select.selectOption('EXEMPT');
    await page.getByTestId('global-category-confirm-yes').click();
    await server(page.getByText(`Regla de «${name}» guardada.`).first()).toBeVisible();
    await expect(row.getByRole('combobox')).toHaveValue('EXEMPT');
    // Un nombre repetido se explica junto al campo.
    await page.getByTestId('category-new-name').fill(name);
    await page.getByTestId('category-add').click();
    await expect(page.getByText('que no exista ya como categoría global')).toBeVisible();
    await expect(page.getByTestId('category-new-name')).toHaveAttribute('aria-invalid', 'true');
    await expectNoSeriousA11yViolations(page);
    await expectNoHorizontalOverflow(page);
    await expectNoMissingTranslations(page);
  } finally {
    await withE2eDb((db) => db.query(`DELETE FROM "GlobalCategory" WHERE "name" = $1`, [name]));
  }
  expect(errors).toEqual([]);
});

test('la bandeja de soporte lista lo de KORUM con las entidades primero, contesta una vez, avisa sin copiar el texto y cierra una rectificación', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  const entity = await enterAsSuperadmin(page, isMobile);
  const since = Date.now();
  const family = newTicketCode();
  const fromOrg = newTicketCode();
  const toCenter = newTicketCode();
  const rectification = newTicketCode();
  await withE2eDb(async (db) => {
    const { rows } = await db.query<{ id: string; name: string }>(`SELECT "id", "name" FROM "Organization" WHERE "slug" = $1`, [entity.slug]);
    const org = rows[0]!;
    const insert = (code: string, target: string, topic: string, subject: string, fromOrganization: boolean) =>
      db.query(
        `INSERT INTO "SupportTicket" ("ticketCode", "organizationId", "originLabel", "senderEmail", "target", "topic", "subject", "message", "fromOrganization", "updatedAt")
         VALUES ($1, $2, $3, $4, $5::"SupportTarget", $6::"SupportTopic", $7, $8, $9, now())`,
        [code, org.id, org.name, entity.director, target, topic, subject, `Texto de la consulta «${subject}» escrito para la prueba.`, fromOrganization]
      );
    await insert(family, 'SUPERADMIN', 'PAYMENT', 'No me llega el recibo', false);
    await insert(fromOrg, 'SUPERADMIN', 'PAYMENT', 'Duda con una liquidación', true);
    await insert(toCenter, 'ORGANIZATION', 'INITIATIVE', 'Sobre el cartel del festival', false);
    await insert(rectification, 'SUPERADMIN', 'RECTIFICATION', 'Corregir mi nombre', false);
    const user = await db.query<{ id: string }>(`SELECT "id" FROM "User" WHERE lower("email") = lower($1)`, [entity.director]);
    await db.query(`INSERT INTO "PrivacyRequest" ("userId", "requesterEmailHmac", "type", "notes", "dueAt") VALUES ($1, $2, 'RECTIFICATION'::"PrivacyRequestType", $3, now() - interval '1 day')`, [user.rows[0]!.id, randomUUID(), `Soporte ${rectification}`]);
  });

  await page.goto('/admin');
  await expect(page.getByTestId('nav-support')).toContainText(/Soporte \(\d+ consultas?\)/);
  await page.getByTestId('nav-support').click();
  await server(page.getByRole('heading', { level: 1, name: 'Soporte de KORUM' })).toBeVisible();

  const ticket = (code: string) => page.locator(`[data-ticket="${code}"]`);
  await server(ticket(family)).toBeVisible();
  await expect(ticket(toCenter)).toHaveCount(0);
  await expect(ticket(fromOrg).getByTestId('ticket-priority')).toHaveText('Prioritaria: de una entidad');
  // Las de una entidad salen antes que las de una familia.
  const order = await page.locator('[data-testid="support-waiting"] [data-ticket]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-ticket')));
  expect(order.indexOf(fromOrg)).toBeLessThan(order.indexOf(family));
  await expect(ticket(family).getByTestId('ticket-message')).toContainText('No me llega el recibo');
  // El enlace al panel de la entidad es un botón con zona táctil de 44 px, no un enlace suelto dentro del texto.
  const openPanel = await ticket(family).getByTestId('ticket-open-panel').boundingBox();
  expect(openPanel?.height ?? 0).toBeGreaterThanOrEqual(44);

  // Contestar: una sola respuesta, la consulta pasa a «en curso» y el aviso por email no copia el texto.
  await ticket(family).getByTestId('ticket-reply').fill('Te hemos reenviado el recibo a tu correo.');
  await ticket(family).getByTestId('ticket-submit').click();
  await server(page.getByText(`Consulta ${family} actualizada y aviso enviado.`).first()).toBeVisible();
  await expect(ticket(family)).toContainText('Te hemos reenviado el recibo a tu correo.');
  await expect(ticket(family).getByText('En curso')).toBeVisible();
  await expect(ticket(family).getByText(/ya tiene respuesta: solo puedes cambiar su estado/)).toBeVisible();
  await expect(ticket(family).getByTestId('ticket-reply')).toHaveCount(0);
  const mail = await emailTo(entity.director, since, (text) => text.includes(family));
  expect(mail).not.toContain('reenviado');
  expect(mail).toContain('/mi-cuenta');

  // Cerrarla: resuelta, baja a «resueltas» y ya no se toca.
  await ticket(family).getByTestId('ticket-status').selectOption('RESOLVED');
  await ticket(family).getByTestId('ticket-submit').click();
  // El aviso verde de la respuesta sigue a la vista: no puede tapar el botón de confirmar (en móvil los avisos van arriba).
  const yes = ticket(family).getByTestId('ticket-resolve-yes');
  await expect(yes).toBeVisible();
  await yes.scrollIntoViewIfNeeded();
  const covered = await yes.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return !(top && (top === element || element.contains(top)));
  });
  expect(covered).toBe(false);
  // Cerrar es definitivo: pide confirmar y dice que ya no se podrá contestar (esta ya tiene respuesta, así que no habla de «sin responder»).
  await expect(ticket(family).getByTestId('ticket-resolve-confirm')).toContainText('Esta consulta ya tiene respuesta. Se cerrará y no se podrá volver a contestar.');
  await ticket(family).getByTestId('ticket-resolve-yes').click();
  await server(page.locator('[data-testid="support-resolved"]').locator(`[data-ticket="${family}"]`)).toBeVisible();
  await expect(page.locator('[data-testid="support-resolved"]').locator(`[data-ticket="${family}"]`).getByTestId('ticket-submit')).toHaveCount(0);

  // La respuesta a lo que escribe una entidad se lee en su panel.
  await ticket(fromOrg).getByTestId('ticket-reply').fill('Llegará en dos días laborables.');
  await ticket(fromOrg).getByTestId('ticket-submit').click();
  await server(page.getByText(`Consulta ${fromOrg} actualizada y aviso enviado.`).first()).toBeVisible();
  const panelMail = await emailTo(entity.director, since, (text) => text.includes(fromOrg));
  expect(panelMail).toContain(`/panel/${entity.slug}/soporte`);

  // La rectificación enseña su plazo vencido y se cierra con el cambio hecho (pide el TOTP reciente: el recorrido acaba de pasarlo al entrar).
  const block = ticket(rectification).getByTestId('rectification');
  await expect(block).toContainText('El plazo legal de un mes venció');
  await block.getByTestId('rectification-done').click();
  await server(page.getByText('Solicitud cerrada.').first()).toBeVisible();
  const closed = await withE2eDb((db) => db.query(`SELECT "status"::text AS status FROM "PrivacyRequest" WHERE "notes" LIKE $1`, [`Soporte ${rectification}%`]));
  expect(closed.rows[0]!.status).toBe('COMPLETED');

  await expectNoSeriousA11yViolations(page);
  await expectNoHorizontalOverflow(page);
  await expectNoMissingTranslations(page);
  expect(errors).toEqual([]);
});

test('el email directo de KORUM a una entidad sale a quienes firman con su tope por día, y la alerta de dinero bloqueado solo se cierra con una nota', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  await enterAsSuperadmin(page, isMobile);

  // Una entidad de la semilla con quien firma por ella (la de cada proyecto es distinta: el tope es de 3 por entidad y día).
  const target = await withE2eDb(async (db) => {
    const { rows } = await db.query<{ id: string; name: string }>(
      `SELECT o."id", o."name" FROM "Organization" o
        WHERE o."archivedAt" IS NULL AND EXISTS (SELECT 1 FROM "OrganizationMember" m JOIN "User" u ON u."id" = m."userId" WHERE m."organizationId" = o."id" AND m."role" IN ('DIRECTOR', 'COSIGNER') AND u."isSuperadmin" = false AND u."gdprAnonymizedAt" IS NULL)
        ORDER BY o."name" LIMIT 2`
    );
    return rows[isMobile ? 1 : 0] ?? rows[0]!;
  });
  const alertKey = `PAYOUT_BLOCKED:e2e-${randomUUID().slice(0, 8)}`;
  await withE2eDb((db) =>
    db.query(
      `INSERT INTO "OpsAlert" ("id", "type", "severity", "dedupeKey", "organizationId", "targetType", "targetId", "detailJson", "firstSeenAt", "lastSeenAt")
       VALUES ($1, 'PAYOUT_BLOCKED'::"OpsAlertType", 'CRITICAL'::"OpsAlertSeverity", $2, $3, 'EscrowPayout', '99', '{"initiativeId":5,"blockedCents":30000}'::jsonb, now(), now())`,
      [randomUUID(), alertKey, target.id]
    )
  );

  await page.goto(`/admin/entidades/${target.id}#contacto`);
  const form = page.getByTestId('direct-email');
  await server(form).toBeVisible();
  await expect(form.getByTestId('direct-send')).toBeDisabled();
  await form.getByTestId('direct-subject').fill('Revisión de vuestros documentos');
  await form.getByTestId('direct-message').fill('Hola. Hemos revisado la documentación de vuestra entidad y todo está en orden.');
  await form.getByTestId('direct-send').click();
  // Un email enviado no se puede retirar: pide confirmar con el nombre de la entidad.
  await expect(form.getByTestId('direct-confirm')).toContainText(`Se enviará a quienes firman por ${target.name}`);
  await form.getByTestId('direct-confirm-yes').click();
  await server(page.getByText(/Email enviado a \d+ personas?\./).first()).toBeVisible();
  await expect(form.getByTestId('direct-subject')).toHaveValue('');
  const sent = await withE2eDb((db) => db.query(`SELECT count(*)::int AS n FROM "OutboxMessage" WHERE "organizationId" = $1 AND "templateKey" = 'platform.message'`, [target.id]));
  expect(sent.rows[0]!.n).toBeGreaterThanOrEqual(1);
  await expectNoSeriousA11yViolations(page);
  await expectNoHorizontalOverflow(page);

  // La alerta de dinero bloqueado enseña sus cifras y los pasos, avisa de que KORUM no mueve dinero y no se cierra sin una nota válida.
  await page.goto('/admin#avisos');
  const alert = page.locator('[data-alert="PAYOUT_BLOCKED"]', { hasText: target.name }).first();
  await server(alert).toBeVisible();
  const box = alert.getByTestId('blocked-money');
  await expect(box).toContainText('300,00 € que no se pueden enviar');
  await expect(box).toContainText('KORUM no mueve dinero desde aquí');
  await expect(alert.getByTestId('resolve-alert')).toHaveCount(0);
  await expect(box.getByTestId('blocked-resolve')).toBeDisabled();
  await box.getByTestId('blocked-note').fill('Hablado con Paycomet, esperamos su respuesta por escrito.');
  await expectNoSeriousA11yViolations(page);
  await expectNoHorizontalOverflow(page);
  await box.getByTestId('blocked-resolve').click();
  await server(page.getByText(/Alerta cerrada con tu nota/).first()).toBeVisible();
  const closed = await withE2eDb((db) => db.query(`SELECT "status"::text AS status FROM "OpsAlert" WHERE "dedupeKey" = $1`, [alertKey]));
  expect(closed.rows[0]!.status).toBe('RESOLVED');
  await expectNoMissingTranslations(page);
  expect(errors).toEqual([]);
});
