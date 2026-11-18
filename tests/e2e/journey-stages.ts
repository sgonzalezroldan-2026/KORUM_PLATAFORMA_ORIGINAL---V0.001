import { expect, type Locator, type Page } from '@playwright/test';
import { bpsOf, formatCents } from '@/core/finance/money';
import { withE2eDb } from './auth-support';
import { localized, NAVIGATION, server, type Lang, type T } from './journey-support';

/**
 * Etapas de dinero y de puerta del recorrido de certificación (Sprint 5.6): lo que hacen una familia, un comercio, quien dirige la entidad y un voluntario de
 * portería, cada uno en su navegador. Los importes se leen de la pantalla (lo que ve la persona), se comprueban con su fórmula y se devuelven en céntimos:
 * al final del recorrido se comparan, uno a uno, con lo que quedó en el libro mayor (`ledgerOf`).
 */

/** Céntimos de un importe tal como se ve en castellano o catalán (`1.234,56 €`). Un importe negativo no se espera en ninguna pantalla del recorrido: falla. */
export function parseMoney(text: string): number {
  if (/[-−–]\s*\d/.test(text)) throw new Error(`Importe negativo inesperado: «${text}»`);
  return Number(text.replace(/\D/g, ''));
}

/** Todos los importes de un texto, en céntimos y en orden de aparición. */
export const moneyIn = (text: string): number[] => [...text.matchAll(/[-−–]?\s?\d[\d.]*,\d{2}(?=\s*€)/g)].map((match) => parseMoney(match[0]));

const checkoutModal = (page: Page) => page.locator('#checkout-modal');

/** Abre el pago desde la ficha pública de una iniciativa, como quien pulsa su botón principal. */
export async function openCheckout(page: Page, locale: Lang, slug: string, initiativeId: number): Promise<Locator> {
  await page.goto(localized(locale, `/${slug}/iniciativas/${initiativeId}`));
  await page.locator('#fview-detail a[href$="/aportar"]').click();
  await expect(checkoutModal(page)).toBeVisible(NAVIGATION);
  return checkoutModal(page);
}

/** Paga en el simulador de Paycomet (cobros simulados) y espera la vuelta a KORUM. */
async function confirmSimulatedPayment(page: Page, t: T, order: RegExp) {
  await expect(page).toHaveURL(order, NAVIGATION);
  await page.getByRole('button', { name: t('portal.simulator.confirm') }).click();
  await expect(page).toHaveURL(/\/aportar\/resultado\?pedido=/, NAVIGATION);
}

export interface DonationOptions {
  slug: string;
  initiativeId: number;
  email: string;
  euros: number;
  method: 'BIZUM' | 'CARD';
  /** Con certificado fiscal: NIF, apellidos y nombre y provincia (Barcelona). */
  certificate?: { taxId: string; fullName: string };
  /** Marca la aportación voluntaria a KORUM (viene desmarcada). */
  voluntary?: boolean;
}

/** Una familia aporta como invitada: solo su email. Devuelve lo donado y lo cobrado en total, en céntimos. */
export async function donate(page: Page, t: T, locale: Lang, options: DonationOptions): Promise<{ donationCents: number; chargedCents: number }> {
  const modal = await openCheckout(page, locale, options.slug, options.initiativeId);
  await modal.getByLabel(t('portal.checkout.donation.otherLabel')).first().fill(String(options.euros));
  // La aportación voluntaria a KORUM nunca viene marcada, y con la Ley 49/2002 ya acreditada por la entidad su texto oficial habla del certificado fiscal
  // (Regla 03 §3). Antes de acreditarla no puede haber campaña publicada; el texto del justificante lo cubre `family-checkout-tickets.spec.ts`.
  await expect(modal.getByTestId('guarantee-check')).not.toBeChecked();
  await expect(modal.getByTestId('guarantee-description')).toHaveText(t('portal.checkout.guarantee.descriptionCertificate'));
  if (options.voluntary) await modal.getByTestId('guarantee-check').check();
  // El NIF es opcional: solo se pide a quien quiere su certificado.
  await expect(modal.getByLabel(t('portal.checkout.fiscal.taxId'))).toHaveCount(0);
  if (options.certificate) {
    await modal.getByLabel(t('portal.checkout.fiscal.toggle')).check();
    await modal.getByLabel(t('portal.checkout.fiscal.taxId')).fill(options.certificate.taxId);
    await modal.getByLabel(t('portal.checkout.fiscal.fullName')).fill(options.certificate.fullName);
    await modal.getByLabel(t('portal.checkout.fiscal.province')).selectOption('08');
  }
  await modal.getByLabel(t('portal.checkout.email.label')).fill(options.email);
  const amounts = moneyIn(await modal.getByTestId('checkout-summary').innerText());
  const chargedCents = amounts.at(-1)!;
  const donationCents = options.euros * 100;
  expect(amounts[0]).toBe(donationCents);
  if (options.voluntary) {
    // Donación + aportación voluntaria = total: la voluntaria se cobra aparte, nunca sale de la donación.
    expect(amounts).toHaveLength(3);
    expect(amounts[0]! + amounts[1]!).toBe(chargedCents);
    expect(amounts[1]).toBeGreaterThan(0);
  } else expect(chargedCents).toBe(donationCents);
  const pay = options.method === 'BIZUM' ? t('portal.checkout.pay.bizum', { total: formatCents(chargedCents, locale) }) : t('portal.checkout.pay.card');
  await modal.getByRole('button', { name: pay }).click();
  await confirmSimulatedPayment(page, t, /\/aportar\/simulador\?pedido=KD/);
  const celebration = page.getByTestId('checkout-celebration');
  await expect(celebration.getByRole('heading', { level: 1 })).toContainText(t('portal.result.confirmed.title'), NAVIGATION);
  await expect(celebration).toContainText(t('portal.result.confirmed.paid', { total: formatCents(chargedCents, locale) }));
  return { donationCents, chargedCents };
}

export interface SponsorshipFigures {
  tierCents: number;
  feeCents: number;
  vatCents: number;
  chargedCents: number;
  invoiceNumber: string;
}

/** Un comercio del barrio patrocina la iniciativa con la categoría Oro: el nivel llega íntegro y la gestión con su IVA se suma aparte. */
export async function sponsor(page: Page, t: T, locale: Lang, options: { slug: string; initiativeId: number; name: string; email: string }): Promise<SponsorshipFigures> {
  const modal = await openCheckout(page, locale, options.slug, options.initiativeId);
  await modal.getByRole('tab', { name: t('portal.checkout.tabs.sponsor') }).click();
  await expect(modal.getByRole('tab', { name: t('portal.checkout.tabs.sponsor') })).toHaveAttribute('aria-selected', 'true');
  await modal.getByLabel(t('portal.checkout.sponsor.fields.businessName')).fill(options.name);
  await modal.getByLabel(t('portal.checkout.sponsor.fields.taxId')).fill('B12345674');
  await modal.getByLabel(t('portal.checkout.sponsor.fields.contactPerson')).fill('Marta López');
  await modal.getByLabel(t('portal.checkout.sponsor.fields.phone')).fill('600 11 22 33');
  await modal.getByLabel(t('portal.checkout.sponsor.fields.email')).fill(options.email);
  // La categoría Oro: su etiqueta es el nombre seguido del importe («Or» a secas también aparece dentro de otras palabras).
  await modal.locator('label').filter({ hasText: new RegExp(`^\\W*${t('portal.checkout.sponsor.tier.ORO')}\\s*\\d`) }).click();
  // Nivel íntegro + gestión publicitaria + IVA = total (Regla 02 §5): la gestión es el porcentaje que dice la pantalla sobre el nivel y el IVA, el 21 % de la gestión.
  const summary = await modal.getByTestId('sponsor-summary').innerText();
  const [tierCents, feeCents, vatCents, chargedCents] = moneyIn(summary) as [number, number, number, number];
  const feePercent = Number(/\((\d+(?:,\d+)?)\s*%\)/.exec(summary)?.[1]?.replace(',', '.'));
  expect(feePercent, 'porcentaje de gestión publicitaria en pantalla').toBeGreaterThan(0);
  expect(feeCents).toBe(bpsOf(tierCents, Math.round(feePercent * 100)));
  expect(vatCents).toBe(bpsOf(feeCents, 2_100));
  expect(tierCents + feeCents + vatCents).toBe(chargedCents);
  await modal.getByRole('button', { name: t('portal.checkout.pay.bizum', { total: formatCents(chargedCents, locale) }) }).click();
  await confirmSimulatedPayment(page, t, /\/aportar\/simulador\?pedido=KS/);
  const celebration = page.getByTestId('sponsorship-celebration');
  await expect(celebration.getByRole('heading', { level: 1 })).toContainText(t('portal.result.sponsor.title', { name: options.name }), NAVIGATION);
  await expect(celebration).toContainText(t('portal.result.sponsor.whole.escrow', { amount: formatCents(tierCents, locale) }));
  // La factura de KORUM es solo por la gestión (base + IVA), con su número y su registro Veri*factu: ni el nivel ni el total del cobro aparecen en ella.
  await page.getByTestId('sponsor-doc-factura').click();
  const invoice = page.getByTestId('sponsor-factura');
  await expect(invoice).toBeVisible(NAVIGATION);
  await expect(invoice).toContainText(formatCents(feeCents, locale));
  await expect(invoice).toContainText(formatCents(vatCents, locale));
  await expect(invoice).toContainText(formatCents(feeCents + vatCents, locale));
  await expect(invoice).not.toContainText(formatCents(chargedCents, locale));
  await expect(invoice).not.toContainText(formatCents(tierCents, locale));
  await expect(invoice).toContainText('Veri*factu');
  const invoiceNumber = (await invoice.getByTestId('invoice-number').innerText()).trim();
  expect(invoiceNumber).toMatch(/^FAC-\d{4}-\d{4,}$/);
  return { tierCents, feeCents, vatCents, chargedCents, invoiceNumber };
}

export interface TicketPurchase {
  passPath: string;
  quantity: number;
  unitPriceCents: number;
  /** Gastos de gestión digital por unidad (se suman al comprador, modo `ADD`). */
  unitFeeCents: number;
  chargedCents: number;
}

/** Compra entradas y abre el pase con su QR. Lo cobrado es `cantidad × (precio + Gastos de gestión digital)`, con ese nombre exacto (Regla 02 §6). */
export async function buyTickets(page: Page, t: T, locale: Lang, options: { slug: string; initiativeId: number; email: string; quantity: number; subtype: 'EVENT' }): Promise<TicketPurchase> {
  const modal = await openCheckout(page, locale, options.slug, options.initiativeId);
  for (let added = 1; added < options.quantity; added += 1) await modal.getByRole('button', { name: t('portal.checkout.ticket.more') }).click();
  await expect(modal.getByTestId('ticket-quantity')).toHaveText(String(options.quantity));
  const summary = modal.getByTestId('checkout-summary');
  // El resumen dice «cantidad × precio + los Gastos de gestión digital de todas» y el total: tres importes.
  const [unitPriceCents, feesCents, chargedCents] = moneyIn(await summary.innerText()) as [number, number, number];
  await expect(summary).toContainText(t('portal.checkout.summary.ticketsAdd', { count: options.quantity, price: formatCents(unitPriceCents, locale), fee: formatCents(feesCents, locale) }));
  expect(feesCents).toBeGreaterThan(0);
  // Los gastos son los mismos por cada entrada: se reparten sin resto.
  expect(feesCents % options.quantity).toBe(0);
  const unitFeeCents = feesCents / options.quantity;
  expect(chargedCents).toBe(options.quantity * (unitPriceCents + unitFeeCents));
  await modal.getByLabel(t('portal.checkout.email.label')).fill(options.email);
  await modal.getByRole('button', { name: t('portal.checkout.pay.card') }).click();
  await confirmSimulatedPayment(page, t, /\/aportar\/simulador\?pedido=KT/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(t(`portal.result.confirmed.titleTickets.${options.subtype}`), NAVIGATION);
  await page.getByTestId('view-pass').click();
  await expect(page).toHaveURL(/\/entrada\/[0-9a-f-]{36}\?sig=/, NAVIGATION);
  const url = new URL(page.url());
  return { passPath: url.pathname + url.search, quantity: options.quantity, unitPriceCents, unitFeeCents, chargedCents };
}

/** Quien dirige crea el PIN de la puerta de un evento en «Taquilla y portería» y copia el enlace para los voluntarios. */
export async function createGatePin(page: Page, t: T, locale: Lang, slug: string, title: string): Promise<{ pin: string; gatePath: string }> {
  await page.goto(localized(locale, `/panel/${slug}/taquilla`));
  const card = page.getByTestId('gate-admin-event').filter({ has: page.getByRole('heading', { name: title }) });
  await server(card).toBeVisible();
  await card.getByRole('button', { name: t('panel.gate.pin.create') }).click();
  const pin = (await server(card.getByTestId('gate-admin-pin-digits')).toHaveText(/^\d{6}$/).then(() => card.getByTestId('gate-admin-pin-digits').innerText())).trim();
  const gatePath = await card.getByTestId('gate-admin-link').getAttribute('href');
  expect(gatePath).toMatch(/\/porteria\/[a-z2-7]{10}$/);
  return { pin, gatePath: gatePath! };
}

/** Un voluntario sin cuenta abre el enlace de la puerta en su móvil y entra con el PIN. */
export async function enterGate(page: Page, t: T, gatePath: string, pin: string) {
  await page.goto(gatePath);
  await page.getByLabel(t('gate.pin')).fill(pin);
  await page.getByRole('button', { name: t('gate.enter') }).click();
}

/** Quien está en la puerta no ve dinero ni datos de nadie (QA-SEC05), en ninguna pantalla de la portería. */
export async function expectNoMoneyNorPersonalData(page: Page) {
  const text = await page.locator('main').innerText();
  expect(text, 'la portería no enseña importes').not.toContain('€');
  expect(text, 'la portería no enseña emails').not.toContain('@');
}

/** Lee un pase en la portería (el código llega al campo, como con un lector de teclado o la cámara). */
export async function scanPass(page: Page, t: T, payload: string): Promise<Locator> {
  await page.getByLabel(t('gate.scanner.manual.label')).fill(payload);
  await page.getByRole('button', { name: t('gate.scanner.manual.submit') }).click();
  return page.getByTestId('gate-result');
}

export interface LedgerView {
  /** Asientos de la entidad o de sus iniciativas cuyo debe no es igual a su haber: siempre `0`. */
  unbalancedJournals: number;
  /** Suma de los apuntes de una cuenta y un sentido en los asientos de una iniciativa (o de todas las de la entidad con `'ALL'`). */
  sum(initiativeId: number | 'ALL', account: string, direction: 'DEBIT' | 'CREDIT'): number;
  /** Todo lo cobrado a personas y comercios: debe de `PSP_CLEARING` en los asientos de cobro (`PAYIN_*`). */
  chargedCents: number;
}

/** El libro mayor de una entidad y de sus iniciativas, agregado por iniciativa del asiento, cuenta y sentido. */
export async function ledgerOf(slug: string, initiativeIds: number[]): Promise<LedgerView> {
  return withE2eDb(async (db) => {
    const scope = `(j."organizationId" = (SELECT id FROM "Organization" WHERE slug = $1) OR j."initiativeId" = ANY($2::int[]))`;
    const params = [slug, initiativeIds];
    const unbalanced = await db.query(
      `SELECT j.id FROM "LedgerJournal" j JOIN "EscrowLedgerEntry" e ON e."journalId" = j.id WHERE ${scope}
        GROUP BY j.id HAVING sum(CASE e.direction WHEN 'DEBIT' THEN e."amountCents" ELSE -e."amountCents" END) <> 0`,
      params
    );
    const totals = await db.query(
      `SELECT j."initiativeId" AS initiative, e.account::text AS account, e.direction::text AS direction, sum(e."amountCents")::int AS cents
         FROM "LedgerJournal" j JOIN "EscrowLedgerEntry" e ON e."journalId" = j.id WHERE ${scope} GROUP BY 1, 2, 3`,
      params
    );
    const charged = await db.query(
      `SELECT coalesce(sum(e."amountCents"), 0)::int AS cents FROM "LedgerJournal" j JOIN "EscrowLedgerEntry" e ON e."journalId" = j.id
        WHERE ${scope} AND j.kind::text LIKE 'PAYIN_%' AND e.account = 'PSP_CLEARING' AND e.direction = 'DEBIT'`,
      params
    );
    const rows = totals.rows as Array<{ initiative: number | null; account: string; direction: string; cents: number }>;
    return {
      unbalancedJournals: unbalanced.rowCount ?? 0,
      chargedCents: Number(charged.rows[0].cents),
      sum: (initiativeId, account, direction) => rows.filter((row) => (initiativeId === 'ALL' || row.initiative === initiativeId) && row.account === account && row.direction === direction).reduce((total, row) => total + row.cents, 0)
    };
  });
}
