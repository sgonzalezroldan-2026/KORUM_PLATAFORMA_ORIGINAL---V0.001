import { expect, test, type Page } from '@playwright/test';
import { totpCode } from '../support/totp';
import { emailTo, uniqueEmail, withE2eDb } from './auth-support';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { activateCosigner, registerEntityAndEnterPanel } from './panel-support';

/**
 * QA-S02 (relevo de firmantes sin vaciar la doble firma) · Equipo, grupos y marca de la entidad (Sprint 4.2e), en escritorio (1440) y móvil (430), con
 * axe y sin errores de consola. Quien dirige corrige la invitación de la cofirma (email mal escrito); la cofirma entra y propone relevar a quien dirige
 * (sin esperas ni visto bueno: la invitación sale al momento y quien dirige recibe un aviso); la persona nueva acepta y pasa a dirigir, y quien sale deja
 * de firmar. Dirección también pasa a firma única y vuelve a doble firma desde sus ajustes, al instante (2026-11-12). Después, los grupos
 * (un nombre repetido se rechaza) y la identidad visual (color de la paleta, logotipo y portada) se ven en el portal, y la página se ve en catalán.
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const server = expect.configure({ timeout: 30_000 });

async function checkPage(page: Page, errors: string[], isMobile: boolean) {
  await expectNoSeriousA11yViolations(page);
  await expectNoMissingTranslations(page);
  await expectNoHorizontalOverflow(page);
  if (isMobile) await expectMobileStackIsOneColumn(page);
  expect(errors).toEqual([]);
}

// PNG de 1×1 válido.
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });

/** La última prueba del segundo factor de estas personas, hace 20 minutos: así el relevo pide el código de la app, como pasaría en la vida real. */
const ageSecondFactor = (emails: string[]) =>
  withE2eDb((db) => db.query(`UPDATE "Session" s SET "secondFactorVerifiedAt" = now() - interval '20 minutes' FROM "User" u WHERE u.id = s."userId" AND u.email = ANY($1)`, [emails]));

/** Confirma el código de la app en el diálogo «Confirma que eres tú» (la ventana siguiente: el código de la activación ya se usó). */
async function confirmCode(page: Page, secret: string) {
  const dialog = page.getByRole('dialog', { name: 'Confirma que eres tú' });
  await server(dialog).toBeVisible();
  await dialog.getByLabel('Código de la app').fill(totpCode(secret, Date.now() + 30_000));
  await dialog.getByRole('button', { name: 'Verificar' }).click();
  await server(dialog).toBeHidden();
}

test.describe('Panel de la entidad: equipo que firma, grupos y marca', () => {
  test('corregir la cofirma, relevo sin esperas, grupos, color, logotipo y portada; catalán', async ({ page, browser, isMobile }) => {
    const errors = trackConsoleErrors(page);
    // Cada sección tiene su propio aviso de éxito: se busca el del equipo, no el de los documentos de más arriba.
    const teamNotice = (target: Page) => target.getByRole('region', { name: 'Equipo que firma' }).getByTestId('approvals-notice');
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    const slug = entity.slug;
    const viewport = page.viewportSize();

    // --- Equipo: quien dirige ve su puesto y la invitación pendiente de la cofirma, con el email a medias ---
    await page.goto(`/panel/${slug}/ajustes#equipo`);
    await expect(page.getByRole('heading', { level: 2, name: 'Equipo que firma' })).toBeVisible();
    await expect(page.getByTestId('seat-DIRECTOR')).toContainText('Carla Puig');
    await expect(page.getByTestId('seat-DIRECTOR')).toContainText('Tú');
    const pending = page.getByTestId('seat-COSIGNER-pending');
    await expect(pending).toContainText('Marta Soler');
    await expect(pending).toContainText(/af•••@familias\.example/);
    await expect(pending).not.toContainText(entity.cosigner);
    await checkPage(page, errors, isMobile);

    // --- Corregir la invitación (email mal escrito): la anterior deja de valer y sale una nueva ---
    const correct = page.getByRole('region', { name: 'Corregir la invitación de la cofirma' });
    await correct.getByRole('button', { name: 'Enviar la invitación corregida' }).click();
    await expect(correct.getByText('Revisa los campos marcados.')).toBeVisible();
    await expect(correct.getByLabel('Nombre y apellidos de quien entra')).toBeFocused();
    const cosignerEmail = uniqueEmail('tesoreria');
    await correct.getByLabel('Nombre y apellidos de quien entra').fill('Núria Vidal');
    await correct.getByLabel('Su email').fill(cosignerEmail);
    await correct.getByLabel('Su cargo').fill('Tesorería del AMPA');
    // Decide quién será la segunda firma: se confirma con el código de la app (la activación fue hace un momento, así que se envejece a propósito).
    await ageSecondFactor([entity.director]);
    const correctedAt = Date.now();
    await correct.getByRole('button', { name: 'Enviar la invitación corregida' }).click();
    await confirmCode(page, entity.totpSecret);
    await server(teamNotice(page)).toContainText('Invitación corregida');
    await server(pending).toContainText('Núria Vidal');
    await expect(pending).toContainText('Tesorería del AMPA');

    // La cofirma corregida acepta su invitación en otro navegador.
    const cosigner = await activateCosigner(browser, { ...entity, cosigner: cosignerEmail, registeredAt: correctedAt }, viewport);
    const cosignerErrors = trackConsoleErrors(cosigner.page);
    await ageSecondFactor([entity.director, cosignerEmail]);

    // --- La cofirma propone relevar a quien dirige: se confirma con el código de su app y la invitación sale al momento, sin visto bueno ---
    await cosigner.page.goto(`/panel/${slug}/ajustes#equipo`);
    const propose = cosigner.page.getByRole('region', { name: 'Proponer un relevo' });
    await propose.getByLabel('Dirección: Carla Puig').check();
    const incoming = uniqueEmail('nueva-direccion');
    await propose.getByLabel('Nombre y apellidos de quien entra').fill('Pau Ferrer');
    await propose.getByLabel('Su email').fill(incoming);
    await propose.getByLabel('Su cargo').fill('Dirección del centro');
    const proposedAt = Date.now();
    await propose.getByRole('button', { name: 'Invitar a quien la sustituye' }).click();
    await confirmCode(cosigner.page, cosigner.totpSecret);
    await server(teamNotice(cosigner.page)).toContainText('Invitación enviada');
    await expect(cosigner.page.getByTestId('handover-status')).toContainText('Relevo en curso');
    await expect(cosigner.page.getByTestId('handover-status')).toContainText('Has invitado a Pau Ferrer');
    await expect(cosigner.page.getByTestId('handover-status').getByRole('button', { name: 'Retirar el relevo' })).toBeVisible();
    await checkPage(cosigner.page, cosignerErrors, isMobile);

    // --- Quien dirige recibe un aviso (sin nombres) que no le pide visto bueno; no puede vetar el relevo, solo reenviar la invitación ---
    expect(await emailTo(entity.director, proposedAt, (text) => text.includes('No necesita tu visto bueno'))).not.toContain(incoming);
    await page.reload();
    const status = page.getByTestId('handover-status');
    await expect(status).toContainText('Pau Ferrer');
    await expect(status).toContainText('ocupar tu puesto');
    await expect(status.getByRole('button', { name: 'Retirar el relevo' })).toHaveCount(0);
    await expect(status.getByRole('button', { name: 'Dar mi visto bueno' })).toHaveCount(0);
    await checkPage(page, errors, isMobile);

    // --- La persona nueva acepta: pasa a dirigir y quien sale deja de firmar ---
    const invitation = await emailTo(incoming, proposedAt, (text) => text.includes('/invitacion#t='));
    const link = /https?:\/\/\S+\/invitacion#t=\S+/.exec(invitation)?.[0];
    expect(link).toBeTruthy();
    const newcomerContext = await browser.newContext({ viewport: viewport ?? undefined });
    const newcomer = await newcomerContext.newPage();
    await newcomer.goto(new URL(link!).pathname + new URL(link!).hash);
    await newcomer.getByLabel('Crea tu contraseña').fill(entity.password);
    await newcomer.getByLabel('Repite la contraseña').fill(entity.password);
    await newcomer.getByRole('button', { name: 'Crear contraseña y continuar' }).click();
    await server(newcomer.getByRole('heading', { level: 1, name: 'Activa la verificación en dos pasos' })).toBeVisible();
    await newcomerContext.close();
    await withE2eDb(async (db) => {
      const { rows } = await db.query(
        `SELECT m.role, u.email, m."roleLabel" FROM "OrganizationMember" m JOIN "User" u ON u.id = m."userId" JOIN "Organization" o ON o.id = m."organizationId" WHERE o.slug = $1 ORDER BY m.role`,
        [slug]
      );
      expect(rows).toEqual([
        { role: 'DIRECTOR', email: incoming, roleLabel: 'Dirección del centro' },
        { role: 'COSIGNER', email: cosignerEmail, roleLabel: 'Tesorería del AMPA' }
      ]);
      const org = await db.query(`SELECT "contactEmail", "contactPhone" FROM "Organization" WHERE slug = $1`, [slug]);
      expect(org.rows[0]).toEqual({ contactEmail: incoming, contactPhone: null });
    });
    expect(await emailTo(entity.director, proposedAt, (text) => text.includes('ya no firmas'))).toContain('/ajustes#equipo');

    // --- Grupos de participación (la cofirma, que sigue firmando) ---
    // Misma página con otra ancla: el navegador no la vuelve a pedir, así que se recarga para ver el equipo nuevo.
    await cosigner.page.goto(`/panel/${slug}/ajustes#grupos`);
    await cosigner.page.reload();
    await expect(cosigner.page.getByTestId('seat-DIRECTOR')).toContainText('Pau Ferrer');
    const groups = cosigner.page.getByRole('region', { name: 'Grupos de participación' });
    const primaria = groups.getByLabel('Grupos del bloque').nth(1);
    await expect(primaria).toHaveValue(/3º de Primaria/);
    await primaria.fill(`${await primaria.inputValue()}\n3º Primaria`);
    await groups.getByRole('button', { name: 'Guardar los grupos' }).click();
    await expect(groups.getByText('«3º de Primaria» y «3º Primaria» son el mismo grupo para los enlaces.')).toBeVisible();
    await expect(primaria).toBeFocused();
    await primaria.fill((await primaria.inputValue()).replace('\n3º Primaria', '\nAula de acogida'));
    await groups.getByRole('button', { name: 'Guardar los grupos' }).click();
    await server(groups.getByTestId('approvals-notice')).toContainText('Grupos guardados');
    await withE2eDb(async (db) => {
      const { rows } = await db.query(`SELECT "participationGroupsJson" AS groups FROM "Organization" WHERE slug = $1`, [slug]);
      expect(JSON.stringify(rows[0].groups)).toContain('Aula de acogida');
    });
    await checkPage(cosigner.page, cosignerErrors, isMobile);

    // --- Identidad visual: color de la paleta, logotipo y portada, que se ven en el portal ---
    const brand = cosigner.page.getByRole('region', { name: 'Identidad visual' });
    await brand.getByLabel('Esmeralda').check();
    await brand.getByRole('button', { name: 'Guardar el color' }).click();
    await server(brand.getByTestId('approvals-notice')).toContainText('Color guardado');
    await brand.getByLabel('Logotipo o escudo de la entidad').setInputFiles(png('escudo.png'));
    await brand.getByRole('button', { name: 'Subir logotipo' }).click();
    await server(brand.getByText('Logotipo publicado: ya se ve en vuestro portal.')).toBeVisible();
    await brand.getByLabel('Foto de portada').setInputFiles(png('portada.png'));
    // Sin confirmar que no salen menores reconocibles, no se sube.
    await brand.getByRole('button', { name: 'Subir portada' }).click();
    await expect(brand.getByText('Confirma que en la foto no aparece ningún menor reconocible.')).toBeVisible();
    await brand.getByLabel(/Confirmo que en la foto no aparece ningún menor reconocible/).check();
    await brand.getByRole('button', { name: 'Subir portada' }).click();
    await server(brand.getByText('Portada publicada: ya se ve en vuestro portal.')).toBeVisible();
    await server(cosigner.page.getByTestId('brand-preview').locator('img')).toHaveAttribute('src', /^\/api\/files\/public\/[a-z0-9]+$/);
    // Subir desde otra web: rechazado antes de leer nada.
    const foreign = await cosigner.page.request.post(`/api/panel/marca?orgSlug=${slug}&kind=logo`, { headers: { origin: 'https://otra-web.example' }, multipart: { file: png('ajeno.png') } });
    expect(foreign.status()).toBe(403);
    await checkPage(cosigner.page, cosignerErrors, isMobile);

    await cosigner.page.goto(`/${slug}`);
    const hero = cosigner.page.locator('#school-hero-header');
    const logo = hero.getByTestId('entity-crest').locator('img');
    await expect(logo).toHaveAttribute('src', /^\/api\/files\/public\//);
    expect((await cosigner.page.request.get((await logo.getAttribute('src'))!)).status()).toBe(200);
    await expect(hero).toHaveCSS('border-bottom-color', 'rgb(16, 185, 129)');
    await expect(hero).toHaveCSS('background-image', /url\(/);
    await checkPage(cosigner.page, cosignerErrors, isMobile);

    // «Sin logo»: vuelven las iniciales.
    await cosigner.page.goto(`/panel/${slug}/ajustes#marca`);
    await brand.getByRole('button', { name: 'Quitar el logotipo' }).click();
    await server(brand.getByText('Logotipo retirado')).toBeVisible();
    await server(cosigner.page.getByTestId('brand-preview').locator('img')).toHaveCount(0);
    // El botón pulsado desaparece: el foco va al aviso de la sección.
    await expect(brand.getByTestId('approvals-notice')).toBeFocused();
    await brand.getByRole('button', { name: 'Quitar la portada' }).click();
    await server(brand.getByText('Portada retirada.')).toBeVisible();
    await expect(brand.getByRole('button', { name: 'Quitar la portada' })).toHaveCount(0);

    // --- En catalán ---
    await cosigner.page.goto(`/ca/panel/${slug}/ajustes`);
    await expect(cosigner.page.getByRole('heading', { level: 2, name: 'Equip que signa' })).toBeVisible();
    await expect(cosigner.page.getByRole('heading', { level: 2, name: 'Identitat visual' })).toBeVisible();
    await checkPage(cosigner.page, cosignerErrors, isMobile);
    await cosigner.context.close();
  });

  test('Dirección pasa a firma única y vuelve a doble firma desde sus ajustes, al instante y sin el Super-Admin', async ({ page, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const teamNotice = page.getByRole('region', { name: 'Equipo que firma' }).getByTestId('approvals-notice');
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    const slug = entity.slug;
    await page.goto(`/panel/${slug}/ajustes#equipo`);
    const mode = page.getByTestId('signature-mode');
    await expect(mode).toHaveAttribute('data-mode', 'DOUBLE');
    await expect(page.getByTestId('signature-mode-current')).toContainText('Doble firma');
    await expect(page.getByTestId('seat-COSIGNER-pending')).toBeVisible();

    // Pasar a firma única exige el código reciente y marcar que se entiende lo que cambia.
    await mode.getByTestId('signature-mode-open').click();
    const submit = mode.getByTestId('signature-mode-submit');
    await expect(submit).toBeDisabled();
    await mode.getByTestId('signature-mode-confirm').check();
    await ageSecondFactor([entity.director]);
    await submit.click();
    await confirmCode(page, entity.totpSecret);
    await server(teamNotice).toContainText('una sola firma');
    await server(mode).toHaveAttribute('data-mode', 'SINGLE');
    await expect(page.getByTestId('signature-mode-current')).toContainText('Firma única');
    // Con firma única no hay puesto de cofirma ni invitación pendiente.
    await expect(page.getByTestId('seat-COSIGNER-pending')).toHaveCount(0);
    await expect(page.getByTestId('seat-COSIGNER-empty')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Invitar a la cofirma' })).toHaveCount(0);
    await withE2eDb(async (db) => {
      const { rows } = await db.query(`SELECT o."signatureMode"::text AS mode, (SELECT count(*)::int FROM "AuditLog" a WHERE a."organizationId" = o.id AND a.action = 'signer.signature_mode_changed') AS audited FROM "Organization" o WHERE o.slug = $1`, [slug]);
      expect(rows[0]).toEqual({ mode: 'SINGLE', audited: 1 });
    });
    await checkPage(page, errors, isMobile);

    // Volver a doble firma: el puesto de cofirma queda vacío hasta que se invite.
    await page.getByTestId('signature-mode-open').click();
    await page.getByTestId('signature-mode-confirm').check();
    await ageSecondFactor([entity.director]);
    await page.getByTestId('signature-mode-submit').click();
    await confirmCode(page, entity.totpSecret);
    await server(teamNotice).toContainText('vuelve a doble firma');
    await server(page.getByTestId('signature-mode')).toHaveAttribute('data-mode', 'DOUBLE');
    await expect(page.getByTestId('seat-COSIGNER-empty')).toBeVisible();
    await checkPage(page, errors, isMobile);
  });
});
