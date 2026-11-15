import { expect, test, type Page } from '@playwright/test';
import { withE2eDb } from './auth-support';
import { expectHeadingsInOrder, expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { registerEntityAndEnterPanel, type RegisteredEntity } from './panel-support';

/**
 * Sprint 5.8a · Trazabilidad en el navegador.
 *
 * - **QA-SEC11:** el registro de actividad de la entidad (solo lo suyo, sin las consultas de KORUM ni nombres de familias) y el visor de la auditoría de la
 *   consola (búsqueda por persona sin que el email viaje en la dirección, por entidad, tipo, acción, campaña y fechas; detalle guardado y paginación), en
 *   castellano, catalán e inglés, a 1440 y 430 px, con axe.
 * - **QA-SEC12:** abrir el certificado de otra persona y fallar tres veces la contraseña dejan su fila, y el Super-Admin las encuentra en el visor.
 */

const server = expect.configure({ timeout: 30_000 });
test.describe.configure({ timeout: 240_000 });

interface Ids {
  organizationId: string;
  directorId: string;
}

const idsOf = (entity: RegisteredEntity): Promise<Ids> =>
  withE2eDb(async (db) => {
    const organization = await db.query<{ id: string }>(`SELECT id FROM "Organization" WHERE slug = $1`, [entity.slug]);
    const director = await db.query<{ id: string }>(`SELECT id FROM "User" WHERE lower(email) = lower($1)`, [entity.director]);
    return { organizationId: organization.rows[0]!.id, directorId: director.rows[0]!.id };
  });

type RowInput = { actorType?: 'USER' | 'SYSTEM'; actorUserId?: string | null; organizationId: string | null; action: string; targetType: string; targetId: string; metadata?: Record<string, unknown> };
const insertRows = (rows: RowInput[]) =>
  withE2eDb(async (db) => {
    for (const row of rows) {
      await db.query(`INSERT INTO "AuditLog" ("actorType", "actorUserId", "organizationId", action, "targetType", "targetId", "metadataJson") VALUES ($1::"AuditActorType", $2, $3, $4, $5, $6, $7::jsonb)`, [
        row.actorType ?? 'USER',
        row.actorUserId ?? null,
        row.organizationId,
        row.action,
        row.targetType,
        row.targetId,
        JSON.stringify(row.metadata ?? {})
      ]);
    }
  });

const filters = (page: Page) => page.getByTestId('audit-filters');
/** Un campo de los filtros por su nombre en la dirección: el rótulo de un desplegable incluye el texto de su opción elegida, y varias acciones se parecen a otros rótulos. */
const field = (page: Page, name: string) => filters(page).locator(`[name="${name}"]`);
/** El rótulo que envuelve a ese campo. */
const labelOf = (page: Page, name: string) => filters(page).locator('label').filter({ has: page.locator(`[name="${name}"]`) });
const rowsOf = (page: Page, action: string) => page.locator(`[data-testid="audit-row"][data-action="${action}"]`);

async function checkPage(page: Page, isMobile: boolean) {
  await expectNoSeriousA11yViolations(page);
  await expectHeadingsInOrder(page);
  await expectNoHorizontalOverflow(page);
  await expectNoMissingTranslations(page);
  if (isMobile) await expectMobileStackIsOneColumn(page);
}

test('QA-SEC11 · la entidad ve su registro de actividad: solo lo suyo, en lenguaje llano, con filtros plegados y sin nombres ajenos', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  const entity = await registerEntityAndEnterPanel(page, isMobile);
  const { organizationId, directorId } = await idsOf(entity);
  const outsider = await withE2eDb(async (db) => (await db.query<{ id: string; name: string; email: string }>(`SELECT id, name, email FROM "User" WHERE "isSuperadmin" = false AND name <> '' AND "gdprAnonymizedAt" IS NULL AND id <> $1 ORDER BY "createdAt" ASC LIMIT 1`, [directorId])).rows[0]!);
  const otherOrganization = await withE2eDb(async (db) => (await db.query<{ id: string }>(`SELECT id FROM "Organization" WHERE id <> $1 LIMIT 1`, [organizationId])).rows[0]!.id);
  await insertRows([
    { actorType: 'SYSTEM', organizationId, action: 'initiative.status_changed', targetType: 'Initiative', targetId: '987654', metadata: { initiativeId: 987654, from: 'FUNDRAISING', to: 'GOAL_REACHED', reason: 'GOAL_REACHED' } },
    { actorUserId: outsider.id, organizationId, action: 'support.ticket_created', targetType: 'SupportTicket', targetId: 'TCK-AUDIT1', metadata: { topic: 'INITIATIVE', target: 'ORGANIZATION' } },
    // Una consulta que una familia envía a KORUM y una lectura hecha por otra cuenta: tampoco son de la entidad.
    { actorUserId: outsider.id, organizationId, action: 'support.ticket_created', targetType: 'SupportTicket', targetId: 'TCK-AKORUM', metadata: { topic: 'PAYMENT', target: 'SUPERADMIN' } },
    { actorUserId: outsider.id, organizationId, action: 'kyb.document_opened', targetType: 'KybDocument', targetId: '8642' },
    { actorUserId: directorId, organizationId, action: 'tenant.resource_outside_tenant', targetType: 'EscrowPayout', targetId: '9753' },
    { actorUserId: directorId, organizationId, action: 'payout.requested', targetType: 'EscrowPayout', targetId: '424242', metadata: { amountCents: 123_456 } },
    // Lo que la entidad no debe ver aunque lleve su identificador, y lo de otra entidad.
    { actorUserId: outsider.id, organizationId, action: 'superadmin.access', targetType: 'Organization', targetId: organizationId, metadata: { operation: 'console.organization_360' } },
    { actorType: 'SYSTEM', organizationId, action: 'job.completed', targetType: 'Job', targetId: '5150' },
    { actorUserId: outsider.id, organizationId: otherOrganization, action: 'payout.requested', targetType: 'EscrowPayout', targetId: '777777' }
  ]);

  await page.getByRole('navigation', { name: 'Secciones del panel' }).getByRole('link', { name: 'Registro de actividad' }).click();
  await server(page).toHaveURL(new RegExp(`/panel/${entity.slug}/auditoria$`));
  await server(page.getByRole('heading', { level: 1, name: 'Registro de actividad' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Secciones del panel' }).getByRole('link', { name: 'Registro de actividad' })).toHaveAttribute('aria-current', 'page');

  // Lo ocurrido, con su texto y no con un código interno.
  await expect(rowsOf(page, 'organization.registered').first()).toContainText('Entidad dada de alta');
  const change = rowsOf(page, 'initiative.status_changed');
  await expect(change).toContainText('Cambio de estado de una campaña');
  await expect(change.getByTestId('audit-status-change')).toHaveText('De «Recaudando» a «¡Conseguido!» · Motivo: se alcanzó la meta.');
  await expect(change.getByTestId('audit-actor')).toHaveText('El sistema (automático)');
  await expect(change).toContainText('Campaña 987654');
  // Esa fila se anota en el instante de la aportación que completa la meta: en el panel va solo con su día (Sprint 5.8b, como en el expediente en PDF).
  await expect(change.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}$/);
  await expect(change.locator('time')).not.toContainText(/\d{1,2}:\d{2}/);
  // Lo que hace la propia entidad conserva su hora.
  await expect(rowsOf(page, 'payout.requested').locator('time')).toHaveAttribute('datetime', /T\d{2}:\d{2}:\d{2}/);
  await expect(rowsOf(page, 'payout.requested').locator('time')).toContainText(/\d{1,2}:\d{2}:\d{2}/);
  // Quien firma por la entidad sale con su nombre y su cargo; cualquier otra cuenta, sin nombre.
  await expect(rowsOf(page, 'payout.requested')).toHaveCount(1);
  await expect(rowsOf(page, 'payout.requested').getByTestId('audit-actor')).toContainText('Carla Puig');
  await expect(rowsOf(page, 'payout.requested')).toContainText('Liquidación 424242');
  await expect(rowsOf(page, 'support.ticket_created').getByTestId('audit-actor')).toHaveText('Otra persona');
  // Ni las consultas de KORUM, ni las tareas automáticas, ni lo de otra entidad, ni el detalle guardado, ni datos de otras personas.
  await expect(rowsOf(page, 'superadmin.access')).toHaveCount(0);
  await expect(rowsOf(page, 'job.completed')).toHaveCount(0);
  const main = page.locator('main');
  for (const hidden of ['777777', outsider.name, outsider.email, '123456', '1.234,56', 'Ver el detalle guardado', 'payout.requested', 'TCK-AKORUM', '8642', 'pertenece a otra entidad']) await expect(main).not.toContainText(hidden);
  // Pedir algo de otra entidad se cuenta igual que pedir algo que no existe.
  await expect(page.locator('[data-action="tenant.resource_outside_tenant"]')).toHaveCount(0);
  await expect(rowsOf(page, 'tenant.resource_not_found')).toContainText('Se pidió algo que no existe o que no es de la entidad');
  // De quien no firma por la entidad no se enseña ni el dispositivo; de lo automático se dice que no aplica.
  await expect(rowsOf(page, 'support.ticket_created')).toHaveCount(1);
  await expect(rowsOf(page, 'support.ticket_created').getByTestId('audit-origin')).toHaveCount(0);
  await expect(rowsOf(page, 'initiative.status_changed').getByTestId('audit-origin')).toHaveText('No aplica (es automático)');
  await expect(page.getByRole('heading', { level: 2, name: 'Lo ocurrido, de lo más reciente a lo más antiguo (hora de España)' })).toBeVisible();
  await expect(page.getByTestId('audit-details')).toHaveCount(0);

  // Filtros plegados al cargar; al aplicar uno, viajan en la dirección, se cuentan y se quedan abiertos.
  await expect(filters(page)).not.toHaveAttribute('open', '');
  await checkPage(page, isMobile);
  await filters(page).locator('summary').click();
  await expect(labelOf(page, 'familia')).toContainText('Tipo de actividad');
  await field(page, 'familia').selectOption('money');
  await filters(page).getByRole('button', { name: 'Aplicar filtros' }).click();
  await server(page).toHaveURL(/auditoria\?.*familia=money/);
  await expect(page.getByTestId('audit-filters-active')).toHaveText('1 filtro activo');
  await expect(filters(page)).toHaveAttribute('open', '');
  await expect(page.getByTestId('audit-row')).toHaveCount(1);
  await expect(page.getByTestId('audit-count')).toHaveText('Se muestra 1 registro.');
  await expect(rowsOf(page, 'payout.requested')).toBeVisible();

  // Por persona firmante y por día: hoy sí, ayer no.
  await expect(labelOf(page, 'persona')).toContainText('Persona firmante');
  await field(page, 'persona').selectOption(directorId);
  await filters(page).getByRole('button', { name: 'Aplicar filtros' }).click();
  await server(page.getByTestId('audit-filters-active')).toHaveText('2 filtros activos');
  await expect(page.getByTestId('audit-row')).toHaveCount(1);
  const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() - 86_400_000));
  await expect(labelOf(page, 'hasta')).toContainText('Hasta el día (incluido)');
  await field(page, 'hasta').fill(yesterday);
  await filters(page).getByRole('button', { name: 'Aplicar filtros' }).click();
  await server(page.getByTestId('audit-empty')).toHaveText('No hay nada registrado con esos filtros. Prueba a quitar alguno o a ampliar las fechas.');
  await checkPage(page, isMobile);
  await page.getByTestId('audit-filters-clear').click();
  await server(page).toHaveURL(new RegExp(`/panel/${entity.slug}/auditoria$`));
  await expect(rowsOf(page, 'organization.registered').first()).toBeVisible();

  // Pedir en la dirección la entidad o una persona ajenas no enseña nada de más.
  await page.goto(`/panel/${entity.slug}/auditoria?entidad=${otherOrganization}&persona=${outsider.id}&familia=platform`);
  await server(page.getByTestId('audit-empty')).toBeVisible();
  await expect(main).not.toContainText('777777');

  // En catalán y en inglés.
  await page.goto(`/ca/panel/${entity.slug}/auditoria`);
  await server(page.getByRole('heading', { level: 1, name: 'Registre d’activitat' })).toBeVisible();
  await expect(rowsOf(page, 'initiative.status_changed').getByTestId('audit-status-change')).toContainText('Motiu: es va assolir l’objectiu.');
  await expect(rowsOf(page, 'support.ticket_created').getByTestId('audit-actor')).toHaveText('Una altra persona');
  await checkPage(page, isMobile);
  await page.goto(`/en/panel/${entity.slug}/auditoria`);
  await server(page.getByRole('heading', { level: 1, name: 'Activity log' })).toBeVisible();
  await expect(rowsOf(page, 'organization.registered').first()).toContainText('Organisation registered');
  await checkPage(page, isMobile);

  expect(errors).toEqual([]);
});

test('QA-SEC11 y QA-SEC12 · el Super-Admin busca en la auditoría por persona, entidad y acción, y encuentra el certificado ajeno y las contraseñas fallidas', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  const entity = await registerEntityAndEnterPanel(page, isMobile);
  const { organizationId, directorId } = await idsOf(entity);

  // QA-SEC12 · quien dirige la entidad abre la hoja de una donación que no es suya: ve lo mismo que si no existiera, y queda anotado.
  const foreignDonation = await withE2eDb(async (db) => (await db.query<{ id: number }>(`SELECT id FROM "Contribution" WHERE type = 'DONATION' AND status = 'COMPLETED' AND "refundedCents" = 0 AND ("userId" IS NULL OR "userId" <> $1) ORDER BY id ASC LIMIT 1`, [directorId])).rows[0]!.id);
  await page.goto(`/mi-cuenta/certificados/${foreignDonation}`);
  await server(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('BORRADOR');
  // QA-SEC12 · tres contraseñas mal seguidas contra su cuenta, desde el formulario de acceso de otra persona (sin sesión).
  const statuses = await page.evaluate(async (email) => {
    const results: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch('/api/auth/sign-in/email', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: `contraseña-equivocada-${attempt}` }) });
      results.push(response.status);
    }
    return results;
  }, entity.director);
  expect(statuses).toEqual([401, 401, 401]);
  // La fila del certificado se escribe después de responder (para que el tiempo de respuesta no diga si la donación existe): se espera a que esté.
  await expect.poll(() => withE2eDb(async (db) => (await db.query(`SELECT 1 FROM "AuditLog" WHERE action = 'account.certificate_denied' AND "actorUserId" = $1`, [directorId])).rowCount), { timeout: 15_000 }).toBe(1);
  const gaps = await withE2eDb(async (db) => (await db.query<{ action: string; targetId: string; metadataJson: Record<string, unknown>; ipHash: string | null; row: string }>(`SELECT action, "targetId", "metadataJson", "ipHash", row_to_json(a)::text AS row FROM "AuditLog" a WHERE (action = 'account.certificate_denied' AND "actorUserId" = $1) OR (action = 'auth.sign_in_failed_repeatedly' AND "targetId" = $1) ORDER BY id`, [directorId])).rows);
  expect(gaps.map((gap) => [gap.action, gap.targetId])).toEqual([
    ['account.certificate_denied', String(foreignDonation)],
    ['auth.sign_in_failed_repeatedly', directorId]
  ]);
  expect(gaps[1]!.metadataJson).toMatchObject({ method: 'password', failures: 3, knownAccount: true });
  expect(gaps.every((gap) => gap.ipHash !== null && /^[0-9a-f]{64}$/.test(gap.ipHash))).toBe(true);
  for (const gap of gaps) for (const secret of [entity.director, 'contraseña-equivocada']) expect(gap.row).not.toContain(secret);
  // Hasta aquí el navegador solo ha anotado lo que la prueba ha provocado a propósito: el 404 de la hoja ajena (un 404 de verdad, igual que una que
  // no existe) y los tres 401 de las contraseñas. A partir de aquí, ni un error de consola.
  expect(errors.map((error) => /status of (\d{3})/.exec(error)?.[1] ?? error)).toEqual(['404', '401', '401', '401']);
  errors.length = 0;

  // 60 filas de una misma acción para la paginación, y una fila antigua con un email en su detalle y una campaña que solo existe en esta prueba
  // (escritorio y móvil comparten la base).
  const campaign = 600_000 + Math.floor(Math.random() * 900_000);
  await insertRows([
    ...Array.from({ length: 60 }, (_, index) => ({ actorType: 'SYSTEM' as const, organizationId, action: 'gate.check_in', targetType: 'Initiative', targetId: String(500_000 + index) })),
    { actorUserId: directorId, organizationId, action: 'sponsor.approved', targetType: 'Sponsor', targetId: '31337', metadata: { contactEmail: 'comercio@ejemplo.com', note: 'avisar a comercio@ejemplo.com', initiativeId: campaign } }
  ]);

  await withE2eDb((db) => db.query(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [directorId]));
  await page.goto('/admin');
  await server(page.getByTestId('nav-audit')).toBeVisible();
  await page.getByTestId('nav-audit').click();
  await server(page).toHaveURL(/\/admin\/auditoria$/);
  await server(page.getByRole('heading', { level: 1, name: 'Auditoría de la plataforma' })).toBeVisible();
  await expect(page.getByTestId('audit-row').first()).toBeVisible();
  await expect(filters(page)).not.toHaveAttribute('open', '');
  // Las consultas del propio Super-Admin no tapan lo demás: no salen hasta que se piden.
  await expect(rowsOf(page, 'superadmin.access')).toHaveCount(0);
  await expect(page.getByTestId('audit-korum-hidden')).toContainText('No se muestran las consultas que KORUM hace desde esta consola');
  await checkPage(page, isMobile);
  await page.getByTestId('audit-korum-hidden').getByRole('link', { name: 'Ver las consultas de KORUM' }).click();
  await server(page).toHaveURL(/familia=korumAccess/);
  await server(rowsOf(page, 'superadmin.access').first()).toContainText('Consulta de KORUM desde su consola');
  await expect(page.getByTestId('audit-korum-hidden')).toHaveCount(0);
  await page.getByTestId('audit-filters-clear').click();
  await server(page).toHaveURL(/\/admin\/auditoria$/);

  // Por persona: un email que no es de nadie se dice junto al campo; el de una cuenta lleva a sus filas sin viajar en la dirección.
  const search = page.getByTestId('audit-person-search');
  const email = search.getByLabel('Buscar por persona (su email)');
  await email.fill('nadie-con-este-email@familias.example');
  await search.getByRole('button', { name: 'Buscar persona' }).click();
  await server(page.getByTestId('audit-person-error')).toHaveText('No hay ninguna cuenta con ese email.');
  await expect(email).toBeFocused();
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await email.fill(entity.director);
  await search.getByRole('button', { name: 'Buscar persona' }).click();
  await server(page).toHaveURL(new RegExp(`/admin/auditoria\\?persona=${directorId}$`));
  expect(page.url()).not.toContain(encodeURIComponent(entity.director));
  expect(page.url()).not.toContain(entity.director);
  await expect(page.getByTestId('audit-person-filter')).toContainText(`Viendo lo que hizo o lo que afecta a Carla Puig (${entity.director}).`);
  // Lo que hizo y lo que se hizo contra su cuenta: el certificado ajeno y las contraseñas fallidas.
  await expect(rowsOf(page, 'account.certificate_denied')).toContainText('Intento de abrir el certificado de otra persona');
  await expect(rowsOf(page, 'account.certificate_denied')).toContainText(`Aportación ${foreignDonation}`);
  await expect(rowsOf(page, 'auth.sign_in_failed_repeatedly')).toContainText('Varios inicios de sesión fallidos seguidos');
  await expect(rowsOf(page, 'auth.sign_in_failed_repeatedly').getByTestId('audit-actor')).toHaveText('Alguien sin identificar');
  await expect(rowsOf(page, 'auth.sign_in_failed_repeatedly')).toContainText(/Código de red [0-9a-f]{8}/);
  // La cuenta atacada se dice por su nombre, no por su código.
  await expect(rowsOf(page, 'auth.sign_in_failed_repeatedly').getByTestId('audit-target')).toHaveText(`Cuenta Carla Puig (${entity.director})`);

  // Con la persona puesta, se añade la acción: el detalle guardado sale limpio.
  // Con un filtro puesto, los filtros ya están abiertos.
  await expect(filters(page)).toHaveAttribute('open', '');
  await expect(labelOf(page, 'accion')).toContainText('Qué pasó exactamente');
  await field(page, 'accion').selectOption('sponsor.approved');
  await filters(page).getByRole('button', { name: 'Aplicar filtros' }).click();
  // Los dos filtros viajan juntos en la dirección: la persona, por su identificador.
  await server(page).toHaveURL(new RegExp(`accion=sponsor\\.approved.*persona=${directorId}`));
  await server(page.getByTestId('audit-filters-active')).toHaveText('2 filtros activos');
  await expect(page.getByTestId('audit-row')).toHaveCount(1);
  const approved = rowsOf(page, 'sponsor.approved');
  await expect(approved).toContainText('Comercio admitido');
  await expect(approved.getByTestId('audit-actor')).toContainText(`Carla Puig (${entity.director})`);
  await expect(approved.getByRole('link', { name: entity.name })).toHaveAttribute('href', `/admin/entidades/${organizationId}`);
  await approved.locator('summary').click();
  await expect(approved.getByTestId('audit-details')).toContainText('Código interno: sponsor.approved');
  await expect(approved.getByTestId('audit-details')).toContainText('[redactado]');
  await expect(approved.getByTestId('audit-details')).not.toContainText('comercio@ejemplo.com');
  await checkPage(page, isMobile);

  // Por campaña (también por el detalle guardado) y por entidad.
  await page.goto(`/admin/auditoria?iniciativa=${campaign}`);
  await server(page.getByTestId('audit-row')).toHaveCount(1);
  await expect(rowsOf(page, 'sponsor.approved')).toBeVisible();

  // Paginación de 50 en 50, conservando los filtros.
  await page.goto(`/admin/auditoria?entidad=${organizationId}&accion=gate.check_in`);
  await server(page.getByTestId('audit-row')).toHaveCount(50);
  await expect(page.getByTestId('audit-count')).toHaveText('Se muestran 50 registros.');
  await expect(page.getByTestId('audit-older-top')).toBeVisible();
  await page.getByTestId('audit-older-bottom').click();
  await server(page).toHaveURL(/accion=gate\.check_in&entidad=[^&]+&antes=\d+$/);
  await server(page.getByTestId('audit-row')).toHaveCount(10);
  await expect(page.getByTestId('audit-older-bottom')).toHaveCount(0);
  await page.getByTestId('audit-newest-top').click();
  await server(page.getByTestId('audit-row')).toHaveCount(50);

  // En catalán y en inglés.
  await page.goto(`/ca/admin/auditoria?entidad=${organizationId}&familia=security`);
  await server(page.getByRole('heading', { level: 1, name: 'Auditoria de la plataforma' })).toBeVisible();
  await expect(page.getByTestId('audit-filters-active')).toHaveText('2 filtres actius');
  await checkPage(page, isMobile);
  await page.goto(`/en/admin/auditoria?persona=${directorId}`);
  await server(page.getByRole('heading', { level: 1, name: 'Platform audit log' })).toBeVisible();
  await expect(rowsOf(page, 'auth.sign_in_failed_repeatedly')).toContainText('Several failed sign-ins in a row');
  await checkPage(page, isMobile);

  expect(errors).toEqual([]);
});
