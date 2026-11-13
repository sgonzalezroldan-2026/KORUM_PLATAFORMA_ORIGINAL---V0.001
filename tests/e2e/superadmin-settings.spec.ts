import { expect, test, type Page } from '@playwright/test';
import { emailTo, withE2eDb } from './auth-support';
import { expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { totpCode } from '../support/totp';
import { registerEntityAndEnterPanel, type RegisteredEntity } from './panel-support';

/**
 * Sprint 5.4 · Ajustes de la plataforma (`/admin/ajustes`, QA-A05 · QA-SEC07). Los ajustes son **globales** (todas las pruebas y el proyecto de escritorio y el móvil comparten la
 * misma base), así que lo que guarda datos solo corre en escritorio, toca ajustes que ninguna otra prueba lee (el JET ID de Paycomet, la clave de IndexNow y el texto de cookies en
 * inglés) y lo deja como estaba. El móvil recorre las mismas pantallas y sus validaciones sin guardar nada compartido.
 */

const server = expect.configure({ timeout: 30_000 });
test.describe.configure({ timeout: 240_000 });

const SECRET = 'indexnow-clave-e2e-secreta-98765';

async function enterAsSuperadmin(page: Page, isMobile: boolean): Promise<RegisteredEntity> {
  const entity = await registerEntityAndEnterPanel(page, isMobile);
  await withE2eDb((db) => db.query(`UPDATE "User" SET "isSuperadmin" = true WHERE lower("email") = lower($1)`, [entity.director]));
  return entity;
}

/** Cada prueba limpia **solo** lo suyo: las pruebas de escritorio corren a la vez y borrar el texto o la clave de otra la dejaría con una versión que ya no existe. */
async function cleanup(settings: string[], secrets: string[] = []) {
  await withE2eDb(async (db) => {
    if (settings.length > 0) await db.query(`DELETE FROM "PlatformSetting" WHERE "key" = ANY($1::text[])`, [settings]);
    if (secrets.length > 0) await db.query(`DELETE FROM "PlatformSecret" WHERE "key" = ANY($1::text[])`, [secrets]);
  });
}

test('la pantalla enseña los bloques, los secretos son de solo escritura y «Probar conexión» dice que no hay nada que probar con el simulador; accesible, sin desbordes y en catalán e inglés', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  await enterAsSuperadmin(page, isMobile);
  await page.goto('/admin');
  await server(page.getByTestId('nav-settings')).toBeVisible();
  await page.getByTestId('nav-settings').click();
  await server(page).toHaveURL(/\/admin\/ajustes$/);
  await server(page.getByRole('heading', { level: 1, name: 'Ajustes de la plataforma' })).toBeVisible();
  for (const id of ['pagos', 'email', 'facturacion', 'hucha', 'autoimpulso', 'seo', 'textos', 'limites', 'equipo', 'seguridad', 'historial']) await expect(page.getByTestId(`block-${id}`)).toBeVisible();

  // El modo de cobros lo fija el servidor y se dice con texto; con el simulador no avisa de la IP.
  await expect(page.getByTestId('paycomet-mode')).toContainText('Modo de cobros: simulador.');
  await expect(page.getByTestId('block-pagos').getByText(/Falta la IP pública del servidor/)).toHaveCount(0);

  // Ninguna clave se muestra: todos los campos de clave son de contraseña y vacíos, y la página no lleva ningún valor de secreto.
  const secretInputs = page.locator('input[id^="secret-"]');
  expect(await secretInputs.count()).toBeGreaterThanOrEqual(6);
  for (const input of await secretInputs.all()) {
    await expect(input).toHaveAttribute('type', 'password');
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('autocomplete', 'new-password');
  }

  await page.getByTestId('test-paycomet-button').click();
  await server(page.getByTestId('test-paycomet-result')).toContainText('modo simulador: no se llama a Paycomet');
  await page.getByTestId('test-email-button').click();
  await server(page.getByTestId('test-email-result')).toContainText('los emails se quedan en la vista previa local');

  // Equipo, claves de cifrado y límites fijos: el Super-Admin se ve a sí mismo sin botón de retirarse.
  await expect(page.getByTestId('block-equipo').getByTestId('team-member').first()).toBeVisible();
  await expect(page.getByTestId('block-equipo').getByTestId('team-revoke')).toHaveCount(await page.getByTestId('team-member').count() - 1);
  await expect(page.getByTestId('rotation-state')).toBeVisible();
  await expect(page.getByTestId('fixed-limits')).toBeVisible();
  for (const type of ['CARD_DELETE_FAILED', 'PRIVACY_REQUEST_OVERDUE', 'ENCRYPTION_KEY_MISSING']) await expect(page.getByTestId(`security-alert-${type}`)).toBeVisible();

  await expectNoSeriousA11yViolations(page);
  await expectNoHorizontalOverflow(page);
  await expectNoMissingTranslations(page);

  await page.goto('/ca/admin/ajustes');
  await server(page.getByRole('heading', { level: 1, name: 'Configuració de la plataforma' })).toBeVisible();
  await expect(page.getByTestId('paycomet-mode')).toContainText('Mode de cobraments: simulador.');
  await expectNoSeriousA11yViolations(page);
  await expectNoHorizontalOverflow(page);
  await expectNoMissingTranslations(page);
  await page.goto('/en/admin/ajustes');
  await server(page.getByRole('heading', { level: 1, name: 'Platform settings' })).toBeVisible();
  await expect(page.getByTestId('paycomet-mode')).toContainText('Payments mode: simulator.');
  await expectNoSeriousA11yViolations(page);
  await expectNoMissingTranslations(page);
  expect(errors).toEqual([]);
});

test('guardar un bloque y una clave se anuncia, se recuerda, se audita sin ningún secreto y aparece en el historial; el valor vacío borra y quitar una clave pide confirmar', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Cambia datos compartidos por todas las pruebas: solo en escritorio.');
  const errors = trackConsoleErrors(page);
  await enterAsSuperadmin(page, isMobile);
  try {
    // La auditoría no se borra: se cuenta cuántas filas había antes (esta prueba puede repetirse sobre la misma base).
    const auditsBefore = (await withE2eDb((db) => db.query(`SELECT 1 FROM "AuditLog" WHERE "action" = 'settings.setting.updated' AND "targetId" = 'paycomet.jetId'`))).rowCount ?? 0;
    await page.goto('/admin/ajustes');
    // Un bloque: se guarda, se anuncia, se recuerda al recargar y deja su rastro.
    const jet = page.getByLabel('JET ID');
    await server(jet).toBeVisible();
    await jet.fill('jet-e2e-12345');
    await page.getByTestId('save-pagos').click();
    await server(page.getByText('Ajustes guardados.').first()).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('JET ID')).toHaveValue('jet-e2e-12345');
    // Volver a guardar sin tocar nada lo dice y no escribe.
    await page.getByTestId('save-pagos').click();
    await server(page.getByText('No había nada que cambiar en este bloque.').first()).toBeVisible();
    const audits = await withE2eDb((db) => db.query(`SELECT 1 FROM "AuditLog" WHERE "action" = 'settings.setting.updated' AND "targetId" = 'paycomet.jetId'`));
    expect(audits.rowCount).toBe(auditsBefore + 1);

    // Lo imposible se rechaza con el foco en el campo y sin guardar nada.
    await page.getByLabel('Terminal').fill('abc');
    await page.getByTestId('save-pagos').click();
    await expect(page.getByTestId('settings-outcome').first()).toContainText('Hay un valor que no es válido. Revisa: Terminal.');
    await expect(page.getByLabel('Terminal')).toBeFocused();
    await expect(page.getByLabel('Terminal')).toHaveAttribute('aria-invalid', 'true');
    await page.reload();

    // Una clave: se guarda cifrada, solo se ve su pista y el valor no queda en la página, en el HTML ni en la auditoría.
    const key = page.locator('#secret-seo_indexNowKey');
    await key.fill(SECRET);
    await page.getByTestId('secret-save-seo.indexNowKey').click();
    await server(page.getByText('Clave guardada.').first()).toBeVisible();
    await expect(page.getByTestId('secret-status-seo.indexNowKey')).toContainText('Guardada en la consola · termina en «8765»');
    await expect(key).toHaveValue('');
    expect(await page.content()).not.toContain(SECRET);
    const stored = await withE2eDb((db) => db.query<{ ciphertext: string; hint: string }>(`SELECT "ciphertext", "hint" FROM "PlatformSecret" WHERE "key" = 'seo.indexNowKey'`));
    expect(stored.rows[0]!.ciphertext).not.toContain(SECRET);
    expect(stored.rows[0]!.hint).toBe('8765');
    const secretAudit = await withE2eDb((db) => db.query(`SELECT "metadataJson"::text AS m FROM "AuditLog" WHERE "targetId" = 'seo.indexNowKey'`));
    expect(secretAudit.rowCount).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(secretAudit.rows)).not.toContain(SECRET);
    expect(JSON.stringify(secretAudit.rows)).not.toContain('8765');

    // Quitarla pide confirmar: cancelar no hace nada y confirmar la quita.
    await page.getByTestId('secret-remove-seo.indexNowKey').click();
    await expect(page.getByRole('group', { name: /Quitar Clave de IndexNow/ })).toContainText('el servicio que la necesita dejará de funcionar');
    await page.getByRole('group', { name: /Quitar Clave de IndexNow/ }).getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByTestId('secret-status-seo.indexNowKey')).toContainText('Guardada en la consola');
    await page.getByTestId('secret-remove-seo.indexNowKey').click();
    await page.getByTestId('secret-remove-yes-seo.indexNowKey').click();
    await server(page.getByText('Clave quitada.').first()).toBeVisible();
    await expect(page.getByTestId('secret-status-seo.indexNowKey')).toContainText('Sin configurar.');

    // El valor vacío borra el ajuste (vuelve el valor de respaldo o por defecto).
    await page.getByLabel('JET ID').fill('');
    await page.getByTestId('save-pagos').click();
    await server(page.getByText('Ajustes guardados.').first()).toBeVisible();
    expect((await withE2eDb((db) => db.query(`SELECT 1 FROM "PlatformSetting" WHERE "key" = 'paycomet.jetId'`))).rowCount).toBe(0);

    // El historial lo cuenta todo, de más reciente a más antiguo, sin ningún secreto.
    await page.reload();
    const history = page.getByTestId('history-table');
    await expect(history).toContainText('Ajuste guardado');
    await expect(history).toContainText('Ajuste borrado');
    await expect(history).toContainText('Clave guardada');
    await expect(history).toContainText('Clave quitada');
    // Lo que cambió se nombra en lenguaje llano (no por su clave técnica).
    await expect(history).toContainText('JET ID');
    expect(await history.textContent()).not.toContain('paycomet.jetId');
    expect(await history.textContent()).not.toContain(SECRET);
    await expectNoSeriousA11yViolations(page);
    await expectNoMissingTranslations(page);
  } finally {
    await cleanup(['paycomet.jetId'], ['seo.indexNowKey']);
  }
  expect(errors).toEqual([]);
});

test('el texto legal se guarda como borrador, se publica con una confirmación aparte y desde entonces propone una versión nueva y no deja volver a borrador; los datos de la empresa se validan', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Cambia datos compartidos por todas las pruebas: solo en escritorio.');
  const errors = trackConsoleErrors(page);
  await enterAsSuperadmin(page, isMobile);
  try {
    await page.goto('/admin/ajustes');
    await server(page.getByTestId('legal-matrix')).toBeVisible();
    await page.getByTestId('legal-cookies-en').click();
    await server(page.getByRole('heading', { level: 3, name: 'Editando: Política de cookies · Inglés' })).toBeVisible();
    await expect(page.getByTestId('legal-cookies-en')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('legal-save')).toBeDisabled();
    await page.getByTestId('legal-markdown').fill('# Cookie policy\n\nWe use only essential cookies.');
    await expect(page.getByTestId('legal-save')).toHaveText('Guardar borrador');
    await page.getByTestId('legal-save').click();
    await server(page.getByText(/Texto guardado \(versión \d{4}-\d{2}-\d{2}\)\./).first()).toBeVisible();
    await expect(page.getByTestId('legal-cookies-en')).toContainText('Borrador');

    // Publicar pide confirmar: cancelar no publica; confirmar publica.
    await page.getByRole('radio', { name: 'Publicado' }).check();
    await page.getByTestId('legal-save').click();
    const confirm = page.getByRole('group', { name: /Vas a publicar la versión/ });
    await expect(confirm).toContainText('no podrás editarla');
    await confirm.getByRole('button', { name: 'Cancelar' }).click();
    await expect(confirm).toHaveCount(0);
    await page.getByTestId('legal-save').click();
    await page.getByTestId('legal-confirm').click();
    await server(page.getByTestId('legal-cookies-en')).toContainText('Publicado');
    // Ya publicado: la versión propuesta es la siguiente del mismo día, no se puede volver a borrador y sin texto nuevo no se publica sobre la misma versión.
    await expect(page.getByTestId('legal-version')).toHaveValue(/^\d{4}-\d{2}-\d{2}\.1$/);
    await expect(page.getByRole('radio', { name: 'Borrador' })).toBeDisabled();
    await expect(page.getByText(/Este texto está publicado con la versión/)).toBeVisible();
    await page.getByTestId('legal-version').fill((await page.getByTestId('legal-version').inputValue()).replace('.1', ''));
    await page.getByTestId('legal-markdown').fill('Otro texto bajo la misma versión');
    await page.getByTestId('legal-save').click();
    await page.getByTestId('legal-confirm').click();
    await expect(page.getByTestId('settings-outcome').first()).toContainText('Un texto ya publicado no se puede modificar sin cambiar de versión');
    const stored = await withE2eDb((db) => db.query<{ valueJson: { status: string; version: string } }>(`SELECT "valueJson" FROM "PlatformSetting" WHERE "key" = 'legal.cookies.en'`));
    expect(stored.rows[0]!.valueJson.status).toBe('PUBLICADO');

    // Datos de la empresa: un CIF con el dígito de control mal se rechaza junto al campo y uno válido se guarda.
    await page.reload();
    const company = page.getByTestId('company-form');
    await company.getByLabel('Razón social').fill('KORUM Tecnología S.L.');
    await company.getByLabel('NIF o CIF').fill('B12345679');
    await company.getByLabel('Domicilio').fill('Calle Mayor 1, 28001 Madrid');
    await company.getByLabel('Email de soporte').fill('soporte@korum.test');
    await company.getByLabel('Email de privacidad').fill('privacidad@korum.test');
    await page.getByTestId('save-empresa').click();
    await expect(page.getByTestId('settings-outcome').first()).toContainText('Revisa: NIF o CIF.');
    await company.getByLabel('NIF o CIF').fill('B12345674');
    await page.getByTestId('save-empresa').click();
    await server(page.getByText('Ajustes guardados.').first()).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await expectNoMissingTranslations(page);
  } finally {
    await cleanup(['legal.cookies.en', 'platform.company']);
  }
  expect(errors).toEqual([]);
});

test('el equipo: invitar manda el enlace por email y lista la pendiente, se puede anular, a quien firma por una entidad no se le invita, y con el segundo factor caducado se pide confirmarlo de nuevo', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Cambia datos compartidos por todas las pruebas: solo en escritorio.');
  const errors = trackConsoleErrors(page);
  const entity = await enterAsSuperadmin(page, isMobile);
  // El tope de invitaciones al día es global: una repetición sobre la misma base no debe agotarlo.
  await withE2eDb((db) => db.query(`DELETE FROM "RateLimit" WHERE "key" LIKE 'console:superadmin-invite:%'`));
  const invited = `equipo-${Date.now().toString(36)}@familias.example`;
  try {
    await page.goto('/admin/ajustes#equipo');
    const since = Date.now();
    await page.getByTestId('team-invite-email').fill(invited);
    await page.getByTestId('team-invite-send').click();
    await server(page.getByText('Invitación enviada.').first()).toBeVisible();
    const mail = await emailTo(invited, since);
    expect(mail).toMatch(/\/invitacion#t=/);
    // Hasta que acepte no tiene el rol; aparece como pendiente y se puede anular.
    expect((await withE2eDb((db) => db.query(`SELECT 1 FROM "User" WHERE lower("email") = lower($1) AND "isSuperadmin" = true`, [invited]))).rowCount).toBe(0);
    const pending = page.getByTestId('team-invitation').filter({ hasText: invited });
    await expect(pending).toBeVisible();
    await pending.getByRole('button', { name: `Anular invitación de ${invited}` }).click();
    // Anular pide confirmar (el foco empieza en «Cancelar»); cancelar no anula y confirmar sí.
    await expect(pending.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(pending.getByTestId('team-cancel-invitation-yes')).toHaveCount(0);
    await pending.getByRole('button', { name: `Anular invitación de ${invited}` }).click();
    await pending.getByTestId('team-cancel-invitation-yes').click();
    await server(page.getByText('Invitación anulada.').first()).toBeVisible();
    await expect(page.getByTestId('team-invitation').filter({ hasText: invited })).toHaveCount(0);

    // La cofirma de una entidad (cuenta que firma) no puede ser Super-Admin.
    await withE2eDb((db) => db.query(`INSERT INTO "OrganizationMember" ("userId", "organizationId", "role") SELECT u."id", o."id", 'COSIGNER'::"MemberRole" FROM "User" u, "Organization" o WHERE lower(u."email") = lower($1) AND o."slug" = $2 ON CONFLICT DO NOTHING`, [entity.cosigner, entity.slug]));
    await page.getByTestId('team-invite-email').fill(entity.cosigner);
    await page.getByTestId('team-invite-send').click();
    await expect(page.getByTestId('settings-outcome').first()).toContainText('Esa cuenta firma por una entidad y no puede ser Super-Admin');
    await expect(page.getByTestId('team-invite-email')).toBeFocused();

    // Pasados 10 minutos desde el segundo factor, cualquier cambio pide confirmarlo de nuevo y ofrece el enlace.
    await withE2eDb((db) => db.query(`UPDATE "Session" SET "secondFactorVerifiedAt" = now() - interval '15 minutes' WHERE "userId" = (SELECT "id" FROM "User" WHERE lower("email") = lower($1))`, [entity.director]));
    await page.getByTestId('team-invite-email').fill(`otra-${invited}`);
    await page.getByTestId('team-invite-send').click();
    const alert = page.getByTestId('settings-outcome').first();
    await expect(alert).toContainText('Han pasado más de 10 minutos desde tu último segundo factor');
    await expect(alert.getByRole('link', { name: 'Volver a confirmar mi segundo factor' })).toHaveAttribute('href', /\/acceso\/doble-factor\?next=%2Fadmin%2Fajustes/);
    await expectNoSeriousA11yViolations(page);
    await expectNoMissingTranslations(page);

    // El enlace **funciona**: pide el código de la app (antes devolvía a la misma pantalla sin pedir nada y no se podía seguir sin cerrar sesión) y, con él, se puede volver a guardar.
    await alert.getByRole('link', { name: 'Volver a confirmar mi segundo factor' }).click();
    await server(page.getByRole('heading', { level: 1, name: 'Confirma que eres tú' })).toBeVisible();
    await page.getByLabel('Código de la app').fill(totpCode(entity.totpSecret, Date.now() + 30_000));
    await page.getByRole('button', { name: 'Verificar' }).click();
    await server(page).toHaveURL(/\/admin\/ajustes(#equipo)?$/);
    await page.getByTestId('team-invite-email').fill(`tras-${invited}`);
    await page.getByTestId('team-invite-send').click();
    await server(page.getByText('Invitación enviada.').first()).toBeVisible();
  } finally {
    await withE2eDb(async (db) => {
      await db.query(`DELETE FROM "Verification" WHERE "identifier" LIKE 'korum-invite:%:platform'`);
    });
  }
  expect(errors).toEqual([]);
});
