import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { formatCents } from '@/core/finance/money';
import { validateTaxId } from '@/core/tax/tax-id';
import { emailTo, uniqueEmail, withE2eDb } from './auth-support';
import { trackConsoleErrors } from './helpers';
import { buyTickets, createGatePin, donate, enterGate, expectNoMoneyNorPersonalData, ledgerOf, moneyIn, parseMoney, scanPass, sponsor } from './journey-stages';
import { activateCosigner, checkPage, createKorumReviewer, localized, NAVIGATION, newPerson, pdfFile, photoFile, readQrCode, registerEntity, server, signInFamily, signInStaff, signingEmail, signWithEmailCode, translator, type JourneyEntity, type Lang, type T } from './journey-support';

/**
 * Sprint 5.6 · QA-X03 · Recorrido de certificación de extremo a extremo, como lo vivirían las personas de una entidad real, en escritorio (1440) y móvil (430)
 * y en dos idiomas (castellano y catalán), con cobros simulados:
 *
 *   alta de la entidad ➔ documentos del titular y su verificación ➔ idea de una familia ➔ quórum ➔ doble firma ➔ Estudio ➔ donación + comercio + taquilla ➔
 *   portería ➔ Auto-Impulso ➔ liquidación con factura y fotos Antes/Después ➔ Modelo 182
 *
 * Nada se prepara por detrás: cada dato nace de una pantalla. La única excepción es el permiso de Super-Admin de la persona de KORUM (una cuenta sin ningún
 * cargo en una entidad), que en producción dan `superadmin:bootstrap` o la invitación desde la consola. Los textos salen del catálogo de cada idioma
 * (`journey-support.ts`). En cada pantalla: axe, encabezados en orden, una columna en móvil, sin desbordes, sin claves sin traducir y sin errores de consola;
 * al final, el panel se repasa también en inglés. Cada importe visto en pantalla se compara al final con el libro mayor: cada asiento cuadra, lo cobrado es
 * lo que se vio, cada comisión está en su cuenta y la hucha de la campaña queda a cero tras liquidar.
 *
 * Límite conocido: una campaña no se publica sin el titular verificado, así que en este recorrido el pago siempre ve la Ley 49/2002 ya acreditada (texto del
 * «Certificado Fiscal»). El texto de una entidad sin el régimen («Justificante Nominativo») lo comprueba `family-checkout-tickets.spec.ts`.
 */

test.describe.configure({ timeout: 900_000 });
// Ningún paso espera sin límite: si una pantalla no responde, la prueba lo dice en ese paso y no al agotar el tiempo total.
test.use({ actionTimeout: 45_000, navigationTimeout: 60_000 });

/** Un CIF con dígito de control válido y distinto en cada ejecución. */
function validCif(): string {
  for (let number = 3_000_000 + Math.floor(Math.random() * 6_000_000); ; number += 1) {
    for (const control of '0123456789') {
      const cif = `G${number}${control}`;
      if (validateTaxId(cif).valid) return cif;
    }
  }
}

const KYB_KINDS = ['TAX_ID_CARD', 'STATUTES', 'REPRESENTATIVE_ID', 'ACCOUNT_OWNERSHIP', 'LEY49_ACCREDITATION'] as const;
const DONOR_TAX_ID = '12345678Z';
const PROVIDER_IBAN = 'ES91 2100 0418 4502 0005 1332';
const PANEL_SECTIONS = ['', '/aprobaciones', '/estudio', '/liquidaciones', '/logros', '/taquilla', '/vencidas', '/fondo', '/soporte', '/ajustes'];

/** Quien dirige entrega los documentos del titular (con la acreditación de la Ley 49/2002) y los envía a revisión. */
async function submitHolderDocuments(page: Page, t: T, locale: Lang, entity: JourneyEntity, isMobile: boolean): Promise<string> {
  await page.goto(localized(locale, `/panel/${entity.slug}/ajustes`));
  await server(page.getByRole('heading', { level: 1, name: t('panel.settings.title') })).toBeVisible();
  const cif = validCif();
  await page.getByLabel(t('panel.settings.kyb.identity.cif')).fill(cif);
  await page.getByRole('button', { name: t('panel.settings.kyb.identity.save') }).click();
  await server(page.getByTestId('approvals-notice').first()).toContainText(t('panel.settings.kyb.identity.saved'));
  for (const kind of KYB_KINDS) {
    const name = t(`panel.settings.kyb.documents.kinds.${kind}.title`);
    const row = page.getByTestId(`kyb-${kind}`);
    await row.getByLabel(t('panel.settings.kyb.documents.fileLabel', { name })).setInputFiles(pdfFile(`kyb-${kind}`));
    await row.getByRole('button', { name: t('panel.settings.kyb.documents.upload') }).click();
    await server(row).toContainText(t('panel.settings.kyb.documents.uploaded', { name }));
  }
  await checkPage(page, isMobile);
  await page.getByRole('button', { name: t('panel.settings.kyb.submit.button') }).click();
  await server(page.getByTestId('approvals-notice').first()).toContainText(t('panel.settings.kyb.submit.sent'));
  return cif;
}

/** Publica una taquilla desde su plantilla del Estudio y devuelve su identificador. */
async function publishTicketing(page: Page, t: T, locale: Lang, slug: string, template: 'festival', title: string, fill: () => Promise<void>): Promise<number> {
  await page.goto(localized(locale, `/panel/${slug}/estudio?nueva=taquilla&plantilla=${template}`));
  await page.getByLabel(t('panel.studio.fields.title')).fill(title);
  await fill();
  await expect(page.getByTestId('studio-blockers')).toHaveCount(0);
  await page.getByTestId('studio-publish').click();
  await page.getByTestId('studio-confirm-publish').click();
  await server(page.getByTestId('studio-published')).toBeVisible(NAVIGATION);
  return Number(new URL(page.url()).searchParams.get('iniciativa'));
}

const statusOf = (initiativeId: number) => withE2eDb((db) => db.query(`SELECT status FROM "Initiative" WHERE id = $1`, [initiativeId])).then((result) => String(result.rows[0]?.status));
/** El texto sin espacios: un IBAN no se reconoce si se parte de otra manera. */
const compact = (text: string) => text.replace(/\s/g, '');

for (const locale of ['es', 'ca'] as const) {
  test(`una entidad nace, convierte una idea de las familias en una campaña, la consigue, la liquida y la declara (${locale})`, async ({ page, browser, isMobile }) => {
    const t = translator(locale);
    const errors = trackConsoleErrors(page);
    const tag = `${locale}${isMobile ? 'm' : 'd'}`;
    const money = (cents: number) => formatCents(cents, locale);
    /** Todo lo que se cobra a personas y comercios, tal como lo vieron en pantalla: al final debe ser lo que cobró el libro mayor. */
    const charges: number[] = [];

    // ───────────── 1. Alta de la entidad, segunda firma y la persona de KORUM ─────────────
    const entity = await test.step('alta de la entidad con sus dos personas firmantes', async () => {
      const created = await registerEntity(page, t, locale, { namePrefix: locale === 'es' ? 'Escuela Recorrido' : 'Escola Recorregut', ley49: true });
      await checkPage(page, isMobile);
      return created;
    });
    const cosigner = await activateCosigner(browser, page, t, locale, entity);
    const cosignerErrors = trackConsoleErrors(cosigner.page);
    const korum = await createKorumReviewer(browser, page, t, locale);
    const korumErrors = trackConsoleErrors(korum.page);

    const visitor = await newPerson(browser, page);
    const visitorErrors = trackConsoleErrors(visitor.page);
    await test.step('la portada de una entidad recién nacida guía en lugar de quedarse vacía', async () => {
      await visitor.page.goto(localized(locale, `/${entity.slug}`));
      await server(visitor.page.getByRole('heading', { name: t('portal.catalog.empty.title') })).toBeVisible();
      await checkPage(visitor.page, isMobile);
    });

    // ───────────── 2. Documentos del titular: la entidad los entrega y KORUM los verifica ─────────────
    const orgAdminPath = await test.step('documentos del titular: entrega, revisión y Ley 49/2002 acreditada', async () => {
      const cif = await submitHolderDocuments(page, t, locale, entity, isMobile);
      await korum.page.goto(localized(locale, '/admin/entidades'));
      await korum.page.getByTestId('kyb-waiting').locator('li', { hasText: entity.name }).getByTestId('review-kyb-link').click();
      const kyb = korum.page.getByTestId('block-kyb');
      await server(kyb.getByTestId('kyb-status')).toHaveAttribute('data-status', 'SUBMITTED');
      await expect(kyb.getByTestId('kyb-documents').getByRole('link')).toHaveCount(KYB_KINDS.length);
      await expect(kyb.getByTestId('kyb-documents')).toContainText(cif);
      await kyb.getByLabel(t('admin.org360.kyb.ley49Accredited')).check();
      await kyb.getByLabel(t('admin.org360.kyb.splitId')).fill(`split-recorrido-${tag}-${Date.now().toString(36)}`);
      await checkPage(korum.page, isMobile);
      await kyb.getByTestId('kyb-submit').click();
      await server(kyb.getByTestId('kyb-status')).toHaveAttribute('data-status', 'VERIFIED');
      const organizationId = /\/admin\/entidades\/([^/#?]+)/.exec(korum.page.url())?.[1];
      expect(organizationId).toBeTruthy();
      expect(korumErrors).toEqual([]);
      await korum.context.close();
      return `/admin/entidades/${organizationId}`;
    });

    // ───────────── 3. Una familia propone una idea y la comunidad la lleva al quórum ─────────────
    const ideaTitle = `${locale === 'es' ? 'Toldos para el patio de infantil' : 'Tendals per al pati d’infantil'} ${tag}${Date.now().toString(36)}`;
    await test.step('buzón de ideas: propuesta, moderación y quórum con firmas reales', async () => {
      // La entidad baja el quórum al mínimo que admite (5 firmas).
      await page.goto(localized(locale, `/panel/${entity.slug}/ajustes`));
      await page.getByLabel(t('panel.settings.general.ideas.minVotes')).fill('5');
      await page.getByRole('button', { name: t('panel.settings.general.save') }).click();
      await server(page.getByRole('region', { name: t('panel.settings.general.title') }).getByTestId('approvals-notice')).toContainText(t('panel.settings.general.saved'));

      // La familia autora entra con el código de su email y propone.
      const ideasPath = localized(locale, `/${entity.slug}/ideas`);
      const author = await newPerson(browser, page);
      const authorErrors = trackConsoleErrors(author.page);
      await signInFamily(author.page, t, locale, uniqueEmail('autora'), ideasPath);
      await author.page.getByRole('button', { name: t('portal.ideas.propose') }).first().click();
      const dialog = author.page.locator('#new-idea-modal');
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(t('portal.ideas.dialog.titleLabel')).fill(ideaTitle);
      await dialog.getByRole('combobox', { name: t('portal.ideas.dialog.categoryLabel') }).selectOption({ index: 1 });
      await dialog.getByLabel(t('portal.ideas.dialog.descriptionLabel')).fill(locale === 'es' ? 'En junio no hay sombra en el recreo y los pequeños no pueden salir.' : 'Al juny no hi ha ombra a l’esbarjo i els petits no poden sortir.');
      await dialog.getByRole('button', { name: t('portal.ideas.dialog.submit') }).click();
      await server(dialog).toContainText(/#FAM-\d{4}/);
      await dialog.getByRole('button', { name: t('portal.ideas.dialog.doneClose') }).click();
      await checkPage(author.page, isMobile);

      // La entidad la revisa y abre las firmas.
      await page.goto(localized(locale, `/panel/${entity.slug}/aprobaciones`));
      const card = page.getByTestId('moderation-idea').filter({ hasText: ideaTitle });
      await server(card).toHaveAttribute('data-phase', 'PHASE0_MOD');
      await checkPage(page, isMobile);
      await card.getByRole('button', { name: t('panel.approvals.actions.approve') }).click();
      await server(card).toHaveAttribute('data-phase', 'PUBLIC_VOTING');

      // Cuatro familias más, cada una desde su móvil y su red, firman: con la de la autora son las 5 del quórum.
      for (let index = 2; index <= 5; index += 1) {
        const family = await newPerson(browser, page);
        const familyErrors = trackConsoleErrors(family.page);
        await signInFamily(family.page, t, locale, uniqueEmail(`familia${index}`), ideasPath);
        const idea = family.page.getByTestId('idea-card').filter({ hasText: ideaTitle });
        await expect(idea).toContainText(t('portal.ideas.card.signatures', { count: index - 1, needed: 5 }));
        await idea.getByRole('button', { name: t('portal.ideas.card.sign') }).click();
        await server(family.page.getByTestId('idea-notice')).toBeVisible();
        if (index < 5) await expect(idea).toContainText(t('portal.ideas.card.signatures', { count: index, needed: 5 }));
        else await server(idea).toContainText(t('portal.ideas.card.approved'));
        if (index === 5) await checkPage(family.page, isMobile);
        expect(familyErrors).toEqual([]);
        await family.context.close();
      }
      expect(authorErrors).toEqual([]);
      await author.context.close();
    });

    // ───────────── 4. Doble firma: la idea se convierte en iniciativa ─────────────
    const initiativeId = await test.step('doble firma de la idea: 1/2 → 2/2 con dos personas y enlaces de un solo uso', async () => {
      await page.goto(localized(locale, `/panel/${entity.slug}/aprobaciones`));
      const card = page.getByTestId('moderation-idea').filter({ hasText: ideaTitle });
      await server(card).toHaveAttribute('data-phase', 'DOUBLE_CHECK');
      await expect(card).toContainText(t('panel.approvals.doubleCheck.progress', { total: 2, signed: 0 }));
      const directorSince = Date.now();
      await card.getByRole('button', { name: t('panel.approvals.doubleCheck.request') }).click();
      const directorLink = await signingEmail(entity.director, directorSince, ideaTitle);
      const cosignerSince = Date.now();
      await signWithEmailCode(page, t, directorLink, ideaTitle);
      await server(page.getByRole('heading', { name: t('panel.sign.done.partialTitle') })).toBeFocused();
      await checkPage(page, isMobile);
      // El enlace vale una sola vez: abrirlo de nuevo (en la misma pestaña, donde sigue a la vista la firma hecha) ya no deja firmar.
      await page.goto(directorLink.path);
      await server(page.getByRole('heading', { name: t('panel.sign.missing.title') })).toBeVisible();
      await expect(page.getByLabel(t('panel.sign.otpLabel'))).toHaveCount(0);
      await checkPage(page, isMobile);

      const cosignerLink = await signingEmail(entity.cosigner, cosignerSince, ideaTitle);
      await signWithEmailCode(cosigner.page, t, cosignerLink, ideaTitle);
      await server(cosigner.page.getByRole('heading', { name: t('panel.sign.done.completeTitle') })).toBeVisible();
      await checkPage(cosigner.page, isMobile);

      const { rows } = await withE2eDb((db) => db.query(`SELECT i.id, i.status FROM "Initiative" i JOIN "Idea" d ON d.id = i."sourceIdeaId" WHERE d.title = $1`, [ideaTitle]));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('BUDGETING');
      return Number(rows[0].id);
    });

    // ───────────── 5. Estudio: presupuesto del proveedor, pizarra cuadrada al céntimo y publicación ─────────────
    const publicPath = localized(locale, `/${entity.slug}/iniciativas/${initiativeId}`);
    const board = await test.step('Estudio: pizarra TCO cuadrada y publicación con confirmación', async () => {
      await page.goto(localized(locale, `/panel/${entity.slug}/estudio?iniciativa=${initiativeId}`));
      await server(page.getByRole('heading', { level: 1, name: ideaTitle })).toBeVisible();
      await expect(page.getByTestId('studio-publish')).toBeDisabled();
      await page.getByLabel(t('panel.studio.fields.stage')).selectOption({ index: 1 });
      await page.getByLabel(t('panel.studio.fields.costMat')).fill('600');
      await page.getByLabel(t('panel.studio.fields.costInst')).fill('100');
      await page.getByLabel(t('panel.studio.fields.showBreakdown')).check();
      await expect(page.getByTestId('studio-blockers')).toHaveCount(0);
      const goalCents = parseMoney(await page.getByTestId('studio-goal').innerText());
      // Meta redondeada al euro y pizarra cuadrada: neto + tramos + mantenimiento + pasarela = meta (Regla 02 §1 y §2).
      expect(goalCents % 100).toBe(0);
      const [netCents, bracketCents, maintCents, gatewayCents, sumCents] = moneyIn(await page.getByTestId('studio-gateway-formula').innerText()).slice(-5) as [number, number, number, number, number];
      expect(netCents + bracketCents + maintCents + gatewayCents).toBe(sumCents);
      expect(sumCents).toBe(goalCents);
      // El neto es el presupuesto (600 € + 100 €) más su reserva.
      expect(netCents).toBeGreaterThanOrEqual(70_000);
      await checkPage(page, isMobile);
      await page.getByTestId('studio-publish').click();
      await expect(page.getByRole('alertdialog')).toContainText(money(goalCents));
      await page.getByTestId('studio-confirm-publish').click();
      await server(page.getByTestId('studio-published')).toBeVisible(NAVIGATION);
      await checkPage(page, isMobile);
      return { goalCents, netCents, bracketCents, maintCents, gatewayCents, feesCents: bracketCents + maintCents + gatewayCents };
    });

    await test.step('ficha pública: hucha de la iniciativa y sus 4 líneas, una a una, sumando la meta', async () => {
      await visitor.page.goto(publicPath);
      await server(visitor.page.getByRole('heading', { level: 1, name: ideaTitle })).toBeVisible();
      await expect(visitor.page.getByTestId('wallet-escrow-id')).toHaveText(/^WLT-ESC-[A-Z0-9]{6}$/);
      const lines = moneyIn(await visitor.page.getByTestId('public-breakdown').locator('dl').innerText());
      // Proveedor, instalación, reserva y lo demás (pasarela, plataforma y garantía): cada línea con su importe, no solo la suma.
      expect(lines).toEqual([60_000, 10_000, board.netCents - 70_000, board.feesCents, board.goalCents]);
      await checkPage(visitor.page, isMobile);
    });

    // ───────────── 6. Aportaciones: una familia con certificado fiscal, otra invitada y un comercio del barrio ─────────────
    const shopName = `${locale === 'es' ? 'Panadería La Espiga' : 'Forn L’Espiga'} ${tag}${Date.now().toString(36)}`;
    const certifiedEmail = uniqueEmail('familia-certificado');
    const funding = await test.step('donaciones de dos familias y patrocinio de un comercio con factura Veri*factu', async () => {
      const family = await newPerson(browser, page);
      const familyErrors = trackConsoleErrors(family.page);
      const since = Date.now();
      const first = await donate(family.page, t, locale, { slug: entity.slug, initiativeId, email: certifiedEmail, euros: 25, method: 'BIZUM', certificate: { taxId: DONOR_TAX_ID, fullName: 'García López, Ana' }, voluntary: true });
      await checkPage(family.page, isMobile);
      expect(await emailTo(certifiedEmail, since)).toContain('25,00');
      const second = await donate(family.page, t, locale, { slug: entity.slug, initiativeId, email: uniqueEmail('familia-invitada'), euros: 10, method: 'CARD' });

      const shop = await newPerson(browser, page);
      const shopErrors = trackConsoleErrors(shop.page);
      const sponsorship = await sponsor(shop.page, t, locale, { slug: entity.slug, initiativeId, name: shopName, email: uniqueEmail('comercio') });
      await checkPage(shop.page, isMobile);
      charges.push(first.chargedCents, second.chargedCents, sponsorship.chargedCents);

      // La entidad admite al comercio (decisión sin dinero: basta una firma) y sale en el directorio por su categoría, sin importes.
      await page.goto(localized(locale, `/panel/${entity.slug}/aprobaciones`));
      const sponsorCard = page.getByTestId('moderation-sponsor').filter({ hasText: shopName });
      await server(sponsorCard).toContainText(money(sponsorship.tierCents));
      await sponsorCard.getByRole('button', { name: t('panel.sponsors.approve') }).click();
      await server(sponsorCard).toContainText(t('panel.sponsors.status.APPROVED'));
      await visitor.page.goto(localized(locale, `/${entity.slug}/comercios`));
      const directory = visitor.page.getByRole('list', { name: t('portal.sponsors.listLabel') });
      await server(directory).toContainText(shopName);
      await expect(directory).not.toContainText('€');
      await checkPage(visitor.page, isMobile);

      expect(familyErrors).toEqual([]);
      expect(shopErrors).toEqual([]);
      await family.context.close();
      await shop.context.close();
      return { raisedCents: first.donationCents + second.donationCents + sponsorship.tierCents, voluntaryCents: first.chargedCents - first.donationCents, sponsorship };
    });
    expect(funding.raisedCents).toBeLessThan(board.goalCents);

    // ───────────── 7. Taquilla: dos eventos con entradas, publicados desde el Estudio y comprados por familias; el segundo se agota ─────────────
    const eventTitle = `${locale === 'es' ? 'Fiesta de fin de curso' : 'Festa de final de curs'} ${tag}${Date.now().toString(36)}`;
    const soldOutTitle = `${locale === 'es' ? 'Concierto solidario' : 'Concert solidari'} ${tag}${Date.now().toString(36)}`;
    const gate = await test.step('taquilla: entradas con QR y un evento con todas las entradas vendidas', async () => {
      const eventId = await publishTicketing(page, t, locale, entity.slug, 'festival', eventTitle, async () => {
        await page.getByLabel(t('panel.studio.fields.ticketMax')).fill('10');
      });
      const soldOutId = await publishTicketing(page, t, locale, entity.slug, 'festival', soldOutTitle, async () => {
        await page.getByLabel(t('panel.studio.fields.ticketMax')).fill('4');
      });
      await checkPage(page, isMobile);

      const buyer = await newPerson(browser, page);
      const buyerErrors = trackConsoleErrors(buyer.page);
      const buyerEmail = uniqueEmail('entradas');
      const since = Date.now();
      const entries = await buyTickets(buyer.page, t, locale, { slug: entity.slug, initiativeId: eventId, email: buyerEmail, quantity: 3 });
      // El pase que ve la familia lleva un QR de verdad: se lee como lo leería la cámara de la puerta.
      const qrPayload = await readQrCode(buyer.page.getByRole('img', { name: t('portal.pass.qrAlt') }));
      await expect(buyer.page.getByText(t('portal.pass.quantity', { count: 3 }))).toBeVisible();
      await checkPage(buyer.page, isMobile);
      expect(await emailTo(buyerEmail, since, (text) => text.includes('/entrada/'))).toContain(entries.passPath.split('?')[0]!);

      // El segundo evento: tres entradas para la misma familia y la última para una vecina, que agota el aforo.
      const seats = await buyTickets(buyer.page, t, locale, { slug: entity.slug, initiativeId: soldOutId, email: buyerEmail, quantity: 3 });
      await expect(buyer.page).toHaveTitle(new RegExp(`^${t('portal.pass.title')}`));
      await expect(buyer.page.getByRole('img', { name: t('portal.pass.qrAlt') })).toBeVisible();
      await expect(buyer.page.getByText(t('portal.pass.quantity', { count: 3 }))).toBeVisible();
      await expect(buyer.page.getByText(t('portal.pass.show'))).toBeVisible();
      await checkPage(buyer.page, isMobile);
      const neighbour = await newPerson(browser, page);
      const lastSeat = await buyTickets(neighbour.page, t, locale, { slug: entity.slug, initiativeId: soldOutId, email: uniqueEmail('ultima-entrada'), quantity: 1 });
      await expect(neighbour.page.getByText(t('portal.pass.show'))).toBeVisible();
      charges.push(entries.chargedCents, seats.chargedCents, lastSeat.chargedCents);
      // Con la última entrada el evento completa su aforo y deja de venderse.
      await expect.poll(() => statusOf(soldOutId), { timeout: 30_000 }).toBe('GOAL_REACHED');
      expect(buyerErrors).toEqual([]);
      await buyer.context.close();
      await neighbour.context.close();
      return { eventId, soldOutId, qrPayload, entries, soldOutUnitFeeCents: seats.unitFeeCents, soldOutUnitPriceCents: seats.unitPriceCents };
    });

    // ───────────── 8. Portería: PIN del evento y lectura del pase (QA-SEC05: sin dinero ni datos de nadie) ─────────────
    await test.step('portería con PIN: entrada parcial y alerta roja', async () => {
      const eventGate = await createGatePin(page, t, locale, entity.slug, eventTitle);
      await checkPage(page, isMobile);

      const volunteer = await newPerson(browser, page);
      const volunteerErrors = trackConsoleErrors(volunteer.page);
      await enterGate(volunteer.page, t, eventGate.gatePath, eventGate.pin);
      await server(volunteer.page.getByRole('heading', { name: t('gate.scanner.capacityTitle') })).toBeVisible();
      const capacity = volunteer.page.getByTestId('gate-capacity');
      await expect(capacity).toContainText(t('gate.scanner.capacity', { checkedIn: 0, capacity: 3 }));
      await expectNoMoneyNorPersonalData(volunteer.page);
      await checkPage(volunteer.page, isMobile);

      // Un pase de 3: entran 2 ahora y la tercera persona después; un cuarto intento es la alerta roja.
      let result = await scanPass(volunteer.page, t, gate.qrPayload);
      await expect(result).toHaveAttribute('data-outcome', 'CHOOSE');
      await expectNoMoneyNorPersonalData(volunteer.page);
      await volunteer.page.getByRole('button', { name: t('gate.scanner.result.fewer') }).click();
      await volunteer.page.getByRole('button', { name: t('gate.scanner.result.chooseConfirm', { count: 2 }) }).click();
      await expect(result).toHaveAttribute('data-outcome', 'ACCEPTED');
      await expect(capacity).toContainText(t('gate.scanner.capacity', { checkedIn: 2, capacity: 3 }));
      await expectNoMoneyNorPersonalData(volunteer.page);
      await volunteer.page.getByTestId('gate-next').click();
      result = await scanPass(volunteer.page, t, gate.qrPayload);
      await expect(result).toHaveAttribute('data-outcome', 'ACCEPTED');
      await expect(capacity).toContainText(t('gate.scanner.capacity', { checkedIn: 3, capacity: 3 }));
      await volunteer.page.getByTestId('gate-next').click();
      await scanPass(volunteer.page, t, gate.qrPayload);
      await expect(volunteer.page.getByRole('heading', { name: t('gate.scanner.result.exhausted') })).toBeVisible();
      await expectNoMoneyNorPersonalData(volunteer.page);
      await checkPage(volunteer.page, isMobile);
      expect(volunteerErrors).toEqual([]);
      await volunteer.context.close();
    });

    // ───────────── 9. Auto-Impulso: KORUM completa la meta y decide que se sepa (sin importe) ─────────────
    const missingCents = board.goalCents - funding.raisedCents;
    await test.step('Auto-Impulso desde la consola: no compensa a KORUM, se acepta la pérdida y se decide su visibilidad', async () => {
      const admin = await newPerson(browser, page);
      const adminErrors = trackConsoleErrors(admin.page);
      await signInStaff(admin.page, t, locale, korum, orgAdminPath);
      const row = admin.page.getByTestId('bi-global').locator('tbody tr', { hasText: ideaTitle });
      await server(row).toBeVisible();
      await row.getByTestId('open-popup').click();
      const popup = admin.page.getByTestId('initiative-popup');
      await server(popup.getByRole('heading', { level: 2, name: ideaTitle })).toBeVisible();
      await expect(popup.getByTestId('popup-sponsors')).toContainText(shopName);
      // Lo que KORUM va a poner es justo lo que falta: ni un céntimo más.
      await expect(popup.getByTestId('boost-start')).toHaveText(t('admin.popup.boost.start', { amount: money(missingCents) }));
      await popup.getByRole('radio', { name: t('admin.popup.boost.visibility.SHOW') }).check();
      // Con 1.000 € exentos la campaña no deja comisión: lo único cobrado por KORUM es la aportación voluntaria, muy por debajo de lo que falta. La consola
      // lo dice (no es el Auto-Impulso rentable 💎 de la Regla 02 §10), exige aceptar la pérdida antes de dejar aportar y la vuelve a confirmar.
      await expect(popup.getByTestId('boost-start')).toBeDisabled();
      await popup.getByTestId('boost-accept-loss').check();
      await checkPage(admin.page, isMobile);
      await popup.getByTestId('boost-start').click();
      await popup.getByTestId('boost-confirm').click();
      await expect(popup.getByTestId('boost-loss-panel')).toBeVisible();
      await popup.getByTestId('boost-loss-confirm').click();
      await server(popup.getByTestId('popup-previous-boosts')).toBeVisible();
      expect(adminErrors).toEqual([]);
      await admin.context.close();

      // La ficha pública: meta lograda, se dice que la plataforma ayudó (sin importe) y cuenta como una aportación más.
      expect(await statusOf(initiativeId)).toBe('GOAL_REACHED');
      await visitor.page.goto(publicPath);
      await server(visitor.page.getByTestId('self-boost-note')).toContainText(t('portal.detail.selfBoost'));
      await expect(visitor.page.getByTestId('self-boost-note')).not.toContainText('€');
      await expect(visitor.page.locator('#fview-detail')).toContainText(t('portal.card.contributions', { count: 4 }));
      await checkPage(visitor.page, isMobile);
    });

    // ───────────── 10. Liquidación: al proveedor, con su factura y las dos firmas ─────────────
    await test.step('liquidación al proveedor con factura y doble firma: el dinero sale y la campaña se cierra', async () => {
      await page.goto(localized(locale, `/panel/${entity.slug}/liquidaciones`));
      const card = page.getByTestId(`payout-ready-${initiativeId}`);
      await server(card).toContainText(ideaTitle);
      // Para el proyecto: lo recaudado menos las comisiones de la pizarra, al céntimo.
      await expect(card).toContainText(money(board.goalCents));
      await expect(card).toContainText(money(board.goalCents - board.feesCents));
      await checkPage(page, isMobile);
      const form = page.getByTestId(`payout-form-${initiativeId}`);
      await form.getByLabel(t('panel.payouts.form.toProvider')).check();
      await form.getByLabel(t('panel.payouts.form.providerName')).fill('Toldos Mediterráneo, S.L.');
      await form.getByLabel(t('panel.payouts.form.providerTaxId')).fill('B12345674');
      await form.getByLabel(t('panel.payouts.form.iban')).fill(PROVIDER_IBAN);
      await form.getByLabel(t('panel.payouts.form.invoiceLabel')).setInputFiles(pdfFile('factura-toldos'));
      await server(form.getByTestId('payout-invoice-ready')).toContainText('factura-toldos.pdf');
      const directorSince = Date.now();
      await form.getByRole('button', { name: t('panel.payouts.form.submit') }).click();
      const pending = page.getByTestId(`payout-pending-${initiativeId}`);
      await server(pending).toContainText(t('panel.approvals.doubleCheck.progress', { total: 2, signed: 0 }));
      // El IBAN del proveedor no se enseña entero a nadie: ni partido en grupos ni seguido. Solo su entidad y sus 4 últimas cifras.
      const hidden = compact(PROVIDER_IBAN).slice(8, 20);
      expect(compact(await page.locator('main').innerText())).not.toContain(hidden);

      const directorLink = await signingEmail(entity.director, directorSince, ideaTitle);
      const cosignerSince = Date.now();
      await signWithEmailCode(page, t, directorLink, ideaTitle, async () => expect(compact(await page.locator('main').innerText())).not.toContain(hidden));
      await server(page.getByRole('heading', { name: t('panel.sign.done.partialTitle') })).toBeFocused();
      const cosignerLink = await signingEmail(entity.cosigner, cosignerSince, ideaTitle);
      // Quien cofirma ve qué firma (importe, destinatario y factura) y tampoco ve el IBAN entero. Abre el enlace en la pestaña donde seguía su firma anterior.
      await signWithEmailCode(cosigner.page, t, cosignerLink, ideaTitle, async () => {
        await expect(cosigner.page.getByTestId('sign-payout-amount')).toHaveText(money(board.goalCents - board.feesCents));
        await expect(cosigner.page.getByRole('link', { name: t('panel.sign.payoutInvoice') })).toBeVisible();
        expect(compact(await cosigner.page.locator('main').innerText())).not.toContain(hidden);
      });
      await server(cosigner.page.getByRole('heading', { name: t('panel.sign.done.completeTitle') })).toBeVisible();
      await expect(cosigner.page.getByText(t('panel.sign.done.payout.celebrate'))).toBeVisible();
      await checkPage(cosigner.page, isMobile);
      const { rows } = await withE2eDb((db) =>
        db.query(
          `SELECT i.status, p.status AS payout, p."netPaidCents" AS net, p."korumFeeSettledCents" AS korum, (SELECT coalesce(sum(s."amountCents"), 0)::int FROM "EscrowPayoutSplit" s WHERE s."payoutId" = p.id) AS splits
             FROM "Initiative" i JOIN "EscrowPayout" p ON p."initiativeId" = i.id WHERE i.id = $1`,
          [initiativeId]
        )
      );
      // Lo pagado es la meta menos las comisiones; los repartos cobro a cobro suman exactamente lo pagado.
      expect(rows[0]).toEqual({ status: 'CLOSED', payout: 'EXECUTED', net: board.goalCents - board.feesCents, korum: board.bracketCents + board.maintCents, splits: board.goalCents - board.feesCents });
    });

    // ───────────── 11. Fotos Antes / Después y agradecimiento: el logro se ve en público ─────────────
    await test.step('fotos del Antes y el Después: el logro aparece en el portal en cuanto se publican', async () => {
      await page.goto(localized(locale, `/panel/${entity.slug}/logros`));
      const item = page.getByTestId('achievement-workbench-item').filter({ hasText: ideaTitle });
      // Un evento que sigue a la venta todavía no tiene nada que enseñar: no se ofrece subirle fotos.
      await expect(page.getByTestId('achievement-workbench-item').filter({ hasText: eventTitle })).toHaveCount(0);
      for (const slot of ['BEFORE', 'AFTER'] as const) {
        await item.getByLabel(t('panel.achievements.slotLabel')).selectOption(slot);
        await item.getByLabel(t('panel.achievements.fileLabel'), { exact: true }).setInputFiles(await photoFile(slot.toLowerCase(), slot === 'BEFORE' ? { r: 150, g: 150, b: 150 } : { r: 30, g: 140, b: 90 }));
        await item.getByLabel(t('panel.achievements.minorsLabel')).check();
        await item.getByRole('button', { name: t('panel.achievements.upload') }).click();
        await server(item).toContainText(t(slot === 'BEFORE' ? 'panel.achievements.beforeDone' : 'panel.achievements.afterDone'));
      }
      const thanks = locale === 'es' ? 'Gracias a todas las familias y al comercio del barrio por hacerlo posible.' : 'Gràcies a totes les famílies i al comerç del barri per fer-ho possible.';
      await item.getByLabel(t('panel.achievements.thanksLabel')).fill(thanks);
      await item.getByRole('button', { name: t('panel.achievements.saveThanks') }).click();
      await server(item).toContainText(t('panel.achievements.thanksSaved'));
      await checkPage(page, isMobile);

      await visitor.page.goto(localized(locale, `/${entity.slug}/logros`));
      const achievement = visitor.page.getByTestId('achievement-card').filter({ hasText: ideaTitle });
      await server(achievement.getByTestId('achievement-comparer')).toBeVisible();
      await expect(achievement).toContainText(thanks);
      // Un evento agotado también es un logro, pero no promete fotos del antes y el después: su tarjeta no lleva ese hueco.
      const soldOutCard = visitor.page.getByTestId('achievement-card').filter({ hasText: soldOutTitle });
      await expect(soldOutCard).toBeVisible();
      await expect(soldOutCard.getByTestId('achievement-no-photos')).toHaveCount(0);
      // Las dos fotos han cargado de verdad (una imagen rota también es «visible» por su texto alternativo).
      for (const alt of [t('portal.achievements.beforeAlt', { title: ideaTitle }), t('portal.achievements.afterAlt', { title: ideaTitle })]) {
        await expect.poll(() => achievement.getByRole('img', { name: alt }).evaluate((image) => (image as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
      }
      await checkPage(visitor.page, isMobile);
    });

    // ───────────── 12. Modelo 182: solo la donación con NIF; ni entradas, ni patrocinio, ni Auto-Impulso ─────────────
    await test.step('Modelo 182: fichero de la AEAT con el donativo certificado y nada más', async () => {
      const fiscalYear = await withE2eDb((db) => db.query(`SELECT DISTINCT "fiscalYear" FROM "Contribution" WHERE "initiativeId" = $1 AND type = 'DONATION'`, [initiativeId])).then((result) => Number(result.rows[0]?.fiscalYear));
      await page.goto(localized(locale, `/panel/${entity.slug}`));
      const model = page.getByRole('heading', { name: t('panel.model182.title') }).locator('xpath=ancestor::section[1]');
      await model.getByLabel(t('panel.model182.phone')).fill('934128890');
      await model.getByLabel(t('panel.model182.year')).selectOption(String(fiscalYear));
      const [file] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), model.getByRole('button', { name: t('panel.model182.download') }).click()]);
      expect(file.suggestedFilename()).toBe(`modelo182-${fiscalYear}-${entity.slug}.txt`);
      const records = (await readFile((await file.path())!, 'latin1')).split('\r\n').filter(Boolean);
      // Un registro del declarante y uno por persona declarada, de 250 posiciones: solo la familia que pidió su certificado.
      expect(records).toHaveLength(2);
      expect(records.every((record) => record.length === 250)).toBe(true);
      expect(records[1]).toContain(DONOR_TAX_ID);
      await expect(model.getByRole('status')).toContainText(t('panel.model182.result.done', { year: fiscalYear, donors: 1, total: money(2500) }));
      await expect(model.getByRole('status')).toContainText(t('panel.model182.result.excluded', { count: 1, amount: money(1000) }));
      await checkPage(page, isMobile);
    });

    // ───────────── 13. La familia que donó encuentra su aportación en «Mi cuenta» ─────────────
    await test.step('Mi cuenta de la familia: su donación, con la aportación voluntaria, y sus documentos', async () => {
      const family = await newPerson(browser, page);
      const familyErrors = trackConsoleErrors(family.page);
      await signInFamily(family.page, t, locale, certifiedEmail, localized(locale, '/mi-cuenta'));
      await server(family.page.getByRole('heading', { name: t('account.contributions.title') })).toBeVisible();
      await expect(family.page.locator('main')).toContainText(ideaTitle);
      await expect(family.page.locator('main')).toContainText(t('account.contributions.includesGuarantee'));
      await expect(family.page.getByRole('link', { name: t('account.documents.open') })).toBeVisible();
      await checkPage(family.page, isMobile);
      expect(familyErrors).toEqual([]);
      await family.context.close();
    });

    // ───────────── 14. El panel entero, también en inglés ─────────────
    await test.step('el panel de la entidad en inglés: traducido, accesible y sin desbordes', async () => {
      for (const section of PANEL_SECTIONS) {
        await page.goto(`/en/panel/${entity.slug}${section}`);
        await expect(page.locator('html')).toHaveAttribute('lang', 'en');
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        await checkPage(page, isMobile);
      }
      await page.goto(`/en/panel/${entity.slug}/estudio?iniciativa=${initiativeId}`);
      await expect(page.getByTestId('studio-goal')).toHaveText(formatCents(board.goalCents, 'en'));
      await checkPage(page, isMobile);
    });

    // ───────────── Cierre: el libro mayor cuenta la misma historia que las pantallas ─────────────
    await test.step('libro mayor: cada asiento cuadra, lo cobrado es lo que se vio y cada comisión está en su cuenta', async () => {
      const ledger = await ledgerOf(entity.slug, [initiativeId, gate.eventId, gate.soldOutId]);
      const campaigns = await withE2eDb((db) => db.query(`SELECT id, "raisedCents", "goalCents", "totalContributions", "ticketsSold", "ticketPriceCents" FROM "Initiative" WHERE id = ANY($1::int[]) ORDER BY id`, [[initiativeId, gate.eventId, gate.soldOutId]]));
      const byId = new Map(campaigns.rows.map((row) => [Number(row.id), row]));
      const boost = await withE2eDb((db) => db.query(`SELECT "amountCents", "publiclyDisclosed" FROM "Contribution" WHERE "initiativeId" = $1 AND type = 'SELF_BOOST'`, [initiativeId]));

      // Ningún asiento de la entidad ni de sus tres iniciativas descuadra.
      expect(ledger.unbalancedJournals).toBe(0);
      // Todo lo cobrado a personas y comercios es, céntimo a céntimo, lo que cada una vio en su pantalla de pago.
      expect(ledger.chargedCents).toBe(charges.reduce((total, cents) => total + cents, 0));

      // Campaña de presupuesto: a la hucha entró exactamente la meta (donaciones + nivel del comercio + Auto-Impulso) y tras liquidar no queda nada retenido.
      expect(byId.get(initiativeId)).toMatchObject({ raisedCents: board.goalCents, goalCents: board.goalCents, totalContributions: 4 });
      expect(ledger.sum(initiativeId, 'INITIATIVE_ESCROW', 'CREDIT')).toBe(board.goalCents);
      expect(ledger.sum(initiativeId, 'INITIATIVE_ESCROW', 'DEBIT')).toBe(board.goalCents);
      // La aportación voluntaria, la gestión del comercio y su IVA son de KORUM y de Hacienda, nunca de la hucha.
      expect(ledger.sum(initiativeId, 'KORUM_REVENUE_GUARANTEE', 'CREDIT')).toBe(funding.voluntaryCents);
      expect(ledger.sum(initiativeId, 'KORUM_REVENUE_SPONSOR_FEE', 'CREDIT')).toBe(funding.sponsorship.feeCents);
      expect(ledger.sum(initiativeId, 'TAX_PAYABLE_VAT', 'CREDIT')).toBe(funding.sponsorship.vatCents);
      // El Auto-Impulso es un gasto de KORUM por justo lo que faltaba, y se decidió mostrarlo.
      expect(boost.rows).toEqual([{ amountCents: missingCents, publiclyDisclosed: true }]);
      expect(ledger.sum(initiativeId, 'AUTO_BOOST_EXPENSE', 'DEBIT')).toBe(missingCents);
      // Al liquidar, las comisiones de la pizarra van a sus cuentas y el resto a la entidad, que queda pagada del todo.
      expect(ledger.sum(initiativeId, 'KORUM_REVENUE_BRACKET', 'CREDIT')).toBe(board.bracketCents);
      expect(ledger.sum(initiativeId, 'KORUM_REVENUE_MAINTENANCE', 'CREDIT')).toBe(board.maintCents);
      expect(ledger.sum(initiativeId, 'GATEWAY_FEES_RECOVERED', 'CREDIT')).toBe(board.gatewayCents);
      expect(ledger.sum(initiativeId, 'ORG_PAYABLE', 'CREDIT')).toBe(board.goalCents - board.feesCents);
      expect(ledger.sum(initiativeId, 'ORG_PAYABLE', 'DEBIT')).toBe(board.goalCents - board.feesCents);

      // Taquilla (gastos sumados al comprador): a la hucha de cada evento entra el precio; los Gastos de gestión digital son de KORUM.
      expect(byId.get(gate.eventId)).toMatchObject({ ticketsSold: 3, raisedCents: 3 * gate.entries.unitPriceCents });
      expect(byId.get(gate.soldOutId)).toMatchObject({ ticketsSold: 4, raisedCents: 4 * gate.soldOutUnitPriceCents });
      expect(ledger.sum(gate.eventId, 'INITIATIVE_ESCROW', 'CREDIT') - ledger.sum(gate.eventId, 'INITIATIVE_ESCROW', 'DEBIT')).toBe(3 * gate.entries.unitPriceCents);
      expect(ledger.sum(gate.soldOutId, 'INITIATIVE_ESCROW', 'CREDIT') - ledger.sum(gate.soldOutId, 'INITIATIVE_ESCROW', 'DEBIT')).toBe(4 * gate.soldOutUnitPriceCents);
      expect(ledger.sum(gate.eventId, 'KORUM_REVENUE_TICKET_FEE', 'CREDIT')).toBe(3 * gate.entries.unitFeeCents);
      expect(ledger.sum(gate.soldOutId, 'KORUM_REVENUE_TICKET_FEE', 'CREDIT')).toBe(4 * gate.soldOutUnitFeeCents);
    });

    expect(errors).toEqual([]);
    expect(cosignerErrors).toEqual([]);
    expect(visitorErrors).toEqual([]);
    await cosigner.context.close();
    await visitor.context.close();
  });
}
