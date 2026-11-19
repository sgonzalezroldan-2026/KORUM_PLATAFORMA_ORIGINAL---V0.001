import { randomUUID } from 'node:crypto';
import { expect, test, type Browser } from '@playwright/test';
import { academicYearFor } from '@/core/finance/academic-year';
import { formatCents } from '@/core/finance/money';
import { quarterOf } from '@/core/ideas/idea-conversion';
import { madridIsoDate } from '@/core/studio/studio-draft';
import { emailTo, withE2eDb } from './auth-support';
import { expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { registerEntityAndEnterPanel } from './panel-support';

/**
 * Sprint 5.13 · Reglas de las entradas en navegador (QA-TKT10), con la compilación de producción:
 *  - quien dirige cambia la fecha de un evento desde «Taquilla y portería»: ve hasta qué día puede elegir, confirma y el panel dice hasta cuándo pueden pedir
 *    la devolución; la persona que compró recibe el email con la fecha nueva y su enlace, lo abre sin cuenta, ve cuánto se le devolvería y la pide;
 *  - quien dirige cancela otro evento con ventas y el panel lo confirma; la persona que compró recibe el aviso de que se le devuelve el 100 %;
 *  - la pizarra del Estudio ya dice que el neto es «si se vende todo el aforo».
 * Axe, 430 px, sin claves sin traducir y sin errores de consola.
 */

const server = expect.configure({ timeout: 30_000 });
const EMAIL_LABEL = '📧 Tu email para enviarte al instante tu recibo o tus entradas QR';
const NAVIGATION = { timeout: 45_000 };
const octet = () => 1 + Math.floor(Math.random() * 250);
const DAY = 86_400_000;

test.describe.configure({ timeout: 300_000 });

/** Un evento con entradas de la entidad de la prueba, sin ventas, que acaba dentro de `days` días. */
async function createEvent(slug: string, title: string, days: number): Promise<number> {
  return withE2eDb(async (db) => {
    const walletId = `WLT-ESC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const closesAt = new Date(Date.now() + days * DAY);
    const { rows } = await db.query(
      `INSERT INTO "Initiative" ("walletEscrowId", "format", "organizationId", "academicYear", "title", "category", "stage", "status", "stepIndex", "closesAt", "quarter", "goalCents", "description",
         "ticketSubtype", "ticketPriceCents", "ticketMax", "ticketFeeMode", "ticketVenue", "quotaReservedAt", "updatedAt")
       VALUES ($1, 'TICKETING'::"InitiativeFormat", (SELECT id FROM "Organization" WHERE slug = $2), $3, $4, 'Taquilla', 'Infantil', 'FUNDRAISING'::"InitiativeStatus", 4,
         $5, $6, 50000, 'Prueba E2E de fecha y cancelación', 'EVENT'::"TicketSubtype", 500, 100, 'ADD'::"TicketFeeMode", 'Patio central', now(), now())
       RETURNING id`,
      [walletId, slug, academicYearFor(new Date()), title, closesAt, quarterOf(closesAt)]
    );
    return Number(rows[0].id);
  });
}

/**
 * Una familia compra una entrada como lo haría de verdad: ficha, pago con el simulador de PAYCOMET y webhook firmado. Así la compra tiene su asiento en el
 * libro mayor, que es lo que la devolución refleja (una compra escrita a mano en la base no se podría devolver). Devuelve lo que pagó, en céntimos.
 */
async function buyTicket(browser: Browser, slug: string, initiativeId: number, email: string): Promise<number> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` } });
  const page = await context.newPage();
  await page.goto(`/${slug}/iniciativas/${initiativeId}/aportar`);
  const modal = page.locator('#checkout-modal');
  await expect(modal).toBeVisible(NAVIGATION);
  await modal.getByLabel(EMAIL_LABEL).fill(email);
  await modal.getByRole('button', { name: /Tarjeta, Apple Pay o Google Pay/ }).click();
  await expect(page.getByText('Tarjeta, Apple Pay o Google Pay')).toBeVisible(NAVIGATION);
  await page.getByRole('button', { name: 'Confirmar el pago' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Tus entradas ya son tuyas/, NAVIGATION);
  await context.close();
  const { rows } = await withE2eDb((db) => db.query(`SELECT "totalChargedCents" FROM "Contribution" WHERE "initiativeId" = $1 AND "guestEmail" = $2 AND status = 'COMPLETED'`, [initiativeId, email]));
  return Number(rows[0].totalChargedCents);
}

const euros = (cents: number) => formatCents(cents, 'es');

/** La dirección del botón de un email (en texto plano, la línea que empieza por el dominio de la aplicación), como ruta relativa. */
function linkIn(text: string, pathPart: string): string {
  const line = text.split('\n').find((candidate) => candidate.includes(pathPart));
  if (!line) throw new Error(`el email no lleva un enlace a ${pathPart}`);
  const url = new URL(/https?:\/\/\S+/.exec(line)?.[0] ?? '');
  return `${url.pathname}${url.search}`;
}

test.describe('Sprint 5.13 · fecha y cancelación de un evento', () => {
  test('cambiar la fecha → email con enlace → devolución sin cuenta; cancelar otro evento → aviso del 100 %', async ({ page, browser, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    const buyer = `compra-${randomUUID().slice(0, 8)}@pruebas.example`;
    const other = `compra-${randomUUID().slice(0, 8)}@pruebas.example`;
    const festivalId = await createEvent(entity.slug, 'Festival de primavera', 5);
    const tournamentId = await createEvent(entity.slug, 'Torneo de baloncesto', 6);
    const paid = await buyTicket(browser, entity.slug, festivalId, buyer);
    await buyTicket(browser, entity.slug, tournamentId, other);

    // --- Cambiar la fecha ---
    await page.goto(`/panel/${entity.slug}/taquilla`);
    const festival = page.getByTestId('gate-admin-event').filter({ has: page.getByRole('heading', { name: 'Festival de primavera' }) });
    await server(festival).toBeVisible();
    await expect(festival.getByRole('heading', { name: 'Fecha y cancelación' })).toBeVisible();
    await festival.getByTestId('event-reschedule').click();
    const dateField = festival.getByLabel('Nueva fecha del evento');
    await expect(dateField).toBeFocused();
    await expect(festival.getByTestId('event-reschedule-form')).toContainText('Quien compró la entrada vendida recibirá un email');
    await expectNoSeriousA11yViolations(page);
    if (isMobile) await expectNoHorizontalOverflow(page);
    const newDay = madridIsoDate(new Date(Date.now() + 12 * DAY));
    await dateField.fill(newDay);
    const since = Date.now();
    await festival.getByTestId('event-reschedule-confirm').click();
    await server(festival.getByTestId('event-schedule-done')).toContainText('Fecha cambiada al');
    await expect(festival.getByTestId('event-schedule-refund-open')).toContainText('pueden pedir su devolución hasta el');

    // --- La persona que compró: email con la fecha nueva y su enlace ---
    const mail = await emailTo(buyer, since, (text) => text.includes('cambia de fecha'));
    expect(mail).toContain('tus entradas valen para la nueva fecha');
    expect(mail).toContain('Este enlace es solo tuyo');
    const refundLink = linkIn(mail, '/entrada/devolucion');
    const family = await browser.newContext({ viewport: isMobile ? { width: 430, height: 932 } : { width: 1440, height: 900 }, isMobile, hasTouch: isMobile });
    const familyPage = await family.newPage();
    const familyErrors = trackConsoleErrors(familyPage);
    await familyPage.goto(refundLink);
    await server(familyPage.getByRole('heading', { level: 1, name: '«Festival de primavera» cambia de fecha' })).toBeVisible();
    await expect(familyPage.locator('main')).toContainText(euros(paid));
    await expect(familyPage.locator('main')).toContainText('Si no pides la devolución, tus entradas valen para la nueva fecha.');
    if (isMobile) await expectNoHorizontalOverflow(familyPage);
    await expectNoMissingTranslations(familyPage);
    await expectNoSeriousA11yViolations(familyPage);
    await familyPage.getByTestId('event-refund-ask').click();
    await expect(familyPage.getByTestId('event-refund-confirm')).toContainText(`Te devolveremos ${euros(paid)}`);
    await familyPage.getByTestId('event-refund-yes').click();
    await server(familyPage.getByTestId('event-refund-done')).toContainText('Devolución pedida');
    // Volver al enlace ya no ofrece otra devolución.
    await familyPage.reload();
    await server(familyPage.getByRole('heading', { level: 1, name: 'Ya has pedido la devolución' })).toBeVisible();
    // Un enlace retocado no sirve.
    await familyPage.goto(`${refundLink.slice(0, -1)}${refundLink.endsWith('a') ? 'b' : 'a'}`);
    await server(familyPage.getByRole('heading', { level: 1, name: 'Este enlace de devolución no es válido' })).toBeVisible();
    await expectNoSeriousA11yViolations(familyPage);
    expect(familyErrors).toEqual([]);
    await family.close();

    // --- Cancelar otro evento ---
    await page.goto(`/panel/${entity.slug}/taquilla`);
    const tournament = page.getByTestId('gate-admin-event').filter({ has: page.getByRole('heading', { name: 'Torneo de baloncesto' }) });
    await server(tournament).toBeVisible();
    await tournament.getByTestId('event-cancel').click();
    await expect(tournament.getByTestId('event-cancel-confirm')).toContainText('Se devolverá el 100 % de la entrada vendida');
    // El foco va al aviso, no al botón que cancela: se lee entero y un Intro sin querer no cancela.
    await expect(tournament.getByTestId('event-cancel-confirm')).toBeFocused();
    await expectNoSeriousA11yViolations(page);
    const cancelledAt = Date.now();
    await tournament.getByTestId('event-cancel-yes').click();
    await server(page.getByText('Evento cancelado. Estamos devolviendo el 100 % a quienes compraron y les avisamos por email.')).toBeVisible();
    // Tras recargarse la tarjeta (ya cancelada), el aviso sigue ahí y conserva el foco.
    await server(tournament.getByTestId('gate-admin-closed')).toBeVisible();
    await expect(tournament.getByTestId('event-schedule-done')).toBeFocused();
    const notice = await emailTo(other, cancelledAt, (text) => text.includes('te devolvemos el 100 %'));
    expect(notice).toContain('Tus entradas ya no valen');

    // --- La pizarra del Estudio: el neto es «si se vende todo el aforo» ---
    await page.goto(`/panel/${entity.slug}/estudio`);
    await page.getByRole('link', { name: '+ Nueva taquilla' }).click();
    await server(page.getByTestId('studio-ticket-net-note')).toContainText('al llegar la fecha del evento la entidad recibe lo vendido');
    await expect(page.locator('body')).toContainText('Neto para la entidad si se vende todo el aforo');
    await expectNoMissingTranslations(page);
    if (isMobile) await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });
});
