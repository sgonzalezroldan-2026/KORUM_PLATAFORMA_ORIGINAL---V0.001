import { expect, test, type Page } from '@playwright/test';
import { totpCode } from '../support/totp';
import { emailTo, withE2eDb } from './auth-support';
import { expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { activateCosigner, registerEntityAndEnterPanel } from './panel-support';

/**
 * QA-S02 · Aprobaciones y doble firma del panel (Sprint 4.2a), en escritorio (1440) y móvil (430), con axe y sin errores de consola. Se da de
 * alta una entidad real por la interfaz, se activa también su cofirma con TOTP, y se le preparan en la base de pruebas tres ideas: una
 * propuesta nueva, una que recoge firmas con una firma sospechosa y otra con quórum. Las dos personas firman de verdad con el enlace y el
 * código que reciben por email: la idea pasa de `1/2` a `2/2` y se convierte en iniciativa en presupuestación.
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const server = expect.configure({ timeout: 30_000 });

async function checkPage(page: Page, errors: string[]) {
  await expectNoSeriousA11yViolations(page);
  await expectNoMissingTranslations(page);
  await expectNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
}

interface PreparedIdeas {
  proposal: string;
  voting: string;
  quorum: string;
}

/** Tres ideas de la entidad, con títulos únicos para encontrarlas en pantalla. */
async function prepareIdeas(slug: string, suffix: string): Promise<PreparedIdeas> {
  const titles = { proposal: `Huerto escolar ${suffix}`, voting: `Biblioteca de patio ${suffix}`, quorum: `Toldos para el patio ${suffix}` };
  await withE2eDb(async (db) => {
    const { rows } = await db.query(`SELECT id FROM "Organization" WHERE slug = $1`, [slug]);
    const organizationId = rows[0].id as string;
    const { rows: categories } = await db.query(`SELECT name FROM "GlobalCategory" WHERE name <> 'Taquilla y Rifas' ORDER BY "sortOrder", id LIMIT 1`);
    const category = categories[0].name as string;
    const insert = async (title: string, phase: string, alias: string, verifiedVotes: number, suspiciousVotes: number) => {
      const { rows: created } = await db.query(
        `INSERT INTO "Idea" ("organizationId", alias, "authorCanonicalEmail", title, category, description, phase, votes, "verifiedVotes", "suspiciousVotes", "expiresAt", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7::"IdeaPhase", $8, $9, $10, now() + interval '20 days', now() - interval '2 days') RETURNING id`,
        [organizationId, alias, `autora-${suffix}-${alias.slice(5)}@familias.example`, title, category, 'Una propuesta de las familias para mejorar el centro este curso.', phase, verifiedVotes + suspiciousVotes, verifiedVotes, suspiciousVotes]
      );
      await db.query(`INSERT INTO "IdeaMessage" ("ideaId", "senderRole", "senderLabel", body, "createdAt") VALUES ($1, 'SYSTEM', 'KORUM', $2, now() - interval '2 days')`, [created[0].id, `Propuesta registrada con ${alias}.`]);
      return created[0].id as number;
    };
    await insert(titles.proposal, 'PHASE0_MOD', '#FAM-1111', 1, 0);
    const voting = await insert(titles.voting, 'PUBLIC_VOTING', '#FAM-2222', 2, 1);
    await db.query(`INSERT INTO "IdeaSignatureAudit" ("ideaId", "canonicalEmail", "accountOrder", status, reason, "createdAt") VALUES ($1, $2, 3, 'SUSPICIOUS', 'ideas.audit.tooManyAccounts', now() - interval '1 day')`, [voting, `tercera-${suffix}@familias.example`]);
    await insert(titles.quorum, 'DOUBLE_CHECK', '#FAM-3333', 31, 0);
  });
  return titles;
}

/** El enlace de firma y el código que acaban de llegar a una persona. */
async function signingEmail(address: string, since: number): Promise<{ path: string; otp: string }> {
  const text = await emailTo(address, since);
  const link = /https?:\/\/\S+\/firmar#t=[A-Za-z0-9_-]+/.exec(text)?.[0];
  const otp = /Tu código de 6 dígitos: (\d{6})/.exec(text)?.[1];
  expect(link, 'enlace de firma').toBeTruthy();
  expect(otp, 'código de firma').toBeTruthy();
  const url = new URL(link!);
  return { path: url.pathname + url.hash, otp: otp! };
}

test.describe('Panel de la entidad: aprobaciones y doble firma', () => {
  test('moderar, revalidar, desestimar y firmar 1/2 → 2/2 con dos personas: la idea se convierte en iniciativa', async ({ page, browser, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    const cosigner = await activateCosigner(browser, entity, page.viewportSize());
    const cosignerErrors = trackConsoleErrors(cosigner.page);
    const suffix = entity.slug.slice(-8);
    const ideas = await prepareIdeas(entity.slug, suffix);
    const card = (title: string) => page.getByTestId('moderation-idea').filter({ has: page.getByRole('heading', { name: new RegExp(title) }) });

    // --- La bandeja: lo que pide acción primero, sin emails de las familias ---
    await page.getByRole('navigation', { name: 'Secciones del panel' }).getByRole('link', { name: 'Aprobaciones' }).click();
    await server(page.getByRole('heading', { level: 1, name: 'Aprobaciones y doble firma' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Aprobaciones' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 2, name: '3 ideas en marcha' })).toBeVisible();
    const order = await page.getByTestId('moderation-idea').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-phase')));
    expect(order).toEqual(['PHASE0_MOD', 'DOUBLE_CHECK', 'PUBLIC_VOTING']);
    expect(await page.content()).not.toContain('@familias.example');
    await checkPage(page, errors);

    // --- Aprobar la propuesta con una corrección: abre las firmas ---
    const proposal = card(ideas.proposal);
    const title = proposal.getByLabel('Título');
    await title.fill(`${ideas.proposal} para Primaria`);
    await proposal.getByRole('button', { name: '✅ Aprobar y abrir a firmas' }).click();
    await server(page.getByText('Idea publicada: ya se pueden recoger firmas en el buzón.')).toBeVisible();
    await server(card(`${ideas.proposal} para Primaria`)).toHaveAttribute('data-phase', 'PUBLIC_VOTING');

    // --- Revalidar una firma sospechosa (3ª cuenta de un móvil familiar) ---
    const voting = card(ideas.voting);
    await voting.getByText(/Auditoría de firmas/).click();
    await expect(voting.getByText(/3ª cuenta firmando desde el mismo dispositivo/)).toBeVisible();
    await voting.getByRole('button', { name: 'Dar por buena' }).click();
    await server(page.getByTestId('approvals-notice').first()).toHaveText('Firma validada: ya cuenta para el quórum.');
    await expect(page.getByTestId('approvals-notice').first()).toBeFocused();
    await server(voting.getByText('🟢 Validada por la entidad')).toBeVisible();

    // --- Chat con la familia y desestimar con motivo ---
    await voting.getByLabel('Escribir a #FAM-2222').fill('¡Gracias por la idea! ¿Para qué cursos la pensáis?');
    await voting.getByRole('button', { name: 'Enviar' }).click();
    await server(voting.getByTestId('center-chat-log').getByText('¿Para qué cursos la pensáis?')).toBeVisible();
    await voting.getByRole('button', { name: '❌ Desestimar' }).click();
    await voting.getByLabel('Motivo para #FAM-2222 (lo leerá en su chat)').fill('Este curso no podemos asumir el mantenimiento. ¡Gracias!');
    await voting.getByRole('button', { name: 'Desestimar la idea' }).click();
    await server(page.getByTestId('approvals-notice').first()).toHaveText('Idea desestimada. El motivo está en su chat y la familia recibirá un aviso.');
    await expect(page.getByTestId('approvals-notice').first()).toBeFocused();
    await expect(page.getByRole('heading', { level: 2, name: '2 ideas en marcha' })).toBeVisible();

    // --- 1ª firma (dirección): el enlace y el código llegan por email; el token se borra de la barra ---
    const quorum = card(ideas.quorum);
    await expect(quorum.getByText('Doble firma: 0 de 2')).toBeVisible();
    const directorSince = Date.now();
    await quorum.getByRole('button', { name: '🛡️ Pedir mi enlace de firma' }).click();
    await server(quorum.getByText(/Te hemos enviado a tu email un enlace de un solo uso/)).toBeVisible();
    const director = await signingEmail(entity.director, directorSince);
    const cosignerSince = Date.now();
    await page.goto(director.path);
    await server(page.getByRole('heading', { level: 1, name: 'Doble firma' })).toBeVisible();
    await expect(page.getByText(ideas.quorum)).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    await expect(page).toHaveTitle(/^Doble firma · KORUM$/);
    await checkPage(page, errors);
    await page.getByLabel('Código de 6 dígitos del email').fill(director.otp);
    await page.getByRole('button', { name: 'Firmar' }).click();
    await server(page.getByRole('heading', { name: 'Tu firma está registrada: 1 de 2' })).toBeFocused();
    await expect(page.getByText('Hemos enviado el enlace a la otra persona firmante para completar la doble firma.')).toBeVisible();

    // --- 2ª firma (cofirma), en su propio navegador y con su sesión ---
    const other = await signingEmail(entity.cosigner, cosignerSince);
    await cosigner.page.goto(other.path);
    await server(cosigner.page.getByText(ideas.quorum)).toBeVisible();
    await cosigner.page.getByLabel('Código de 6 dígitos del email').fill(other.otp);
    await cosigner.page.getByRole('button', { name: 'Firmar' }).click();
    await server(cosigner.page.getByRole('heading', { name: '¡Doble firma completa! 2 de 2' })).toBeVisible();
    await checkPage(cosigner.page, cosignerErrors);

    // --- La idea ya es una iniciativa en presupuestación, con su hucha, también en el cuadro de mandos ---
    await page.goto(`/panel/${entity.slug}/aprobaciones`);
    await page.getByText(/Últimas \d+ ideas cerradas|Última idea cerrada/).click();
    const converted = card(ideas.quorum);
    await server(converted.getByText(/Doble firma completa: ya es una iniciativa en presupuestación \(hucha WLT-ESC-[A-Z0-9]{6}\)/)).toBeVisible();
    await converted.getByRole('link', { name: 'Editar en el Estudio' }).click();
    await server(page.getByRole('heading', { level: 1, name: ideas.quorum })).toBeVisible();
    await expect(page.getByTestId('studio-publish')).toBeDisabled();
    await expect(page.getByTestId('studio-blockers')).toContainText('Falta el presupuesto');
    await expect(page.getByTestId('studio-blockers')).toContainText('Indicad a quién beneficia la campaña');
    await checkPage(page, errors);

    // --- La misma bandeja en catalán ---
    await page.goto(`/ca/panel/${entity.slug}/aprobaciones`);
    await server(page.getByRole('heading', { level: 1, name: 'Aprovacions i doble signatura' })).toBeVisible();
    await checkPage(page, errors);
    await cosigner.context.close();
    expect(totpCode(entity.totpSecret)).toMatch(/^\d{6}$/);
  });

  test('/firmar sin sesión guarda el enlace, lo borra de la barra y manda a entrar con la ruta de vuelta', async ({ browser, page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto(`/panel/cervantes/firmar#t=${'A'.repeat(43)}`);
    const login = page.getByRole('link', { name: 'Entrar para firmar' });
    await server(login).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    expect(await login.getAttribute('href')).toContain('/login?next=%2Fpanel%2Fcervantes%2Ffirmar');
    expect(await page.evaluate(() => window.sessionStorage.getItem('korum:double-check:cervantes'))).toBe('A'.repeat(43));
    await checkPage(page, errors);

    // En otra pestaña (sin el enlace guardado) solo se explica qué hacer.
    const fresh = await browser.newPage();
    await fresh.goto('/panel/cervantes/firmar');
    await server(fresh.getByRole('heading', { name: 'Este enlace ya no sirve' })).toBeVisible();
    await fresh.close();
  });
});
