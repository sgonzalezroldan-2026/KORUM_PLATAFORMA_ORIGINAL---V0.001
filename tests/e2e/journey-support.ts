import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { createTranslator } from 'next-intl';
import sharp from 'sharp';
import { totpCode } from '../support/totp';
import { codeTo, emailTo, uniqueEmail, withE2eDb } from './auth-support';
import { expectBoardRowsReadable, expectHeadingsInOrder, expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations } from './helpers';

/**
 * Apoyo del recorrido de certificación (Sprint 5.6). A diferencia del resto de pruebas, aquí **ningún texto de la interfaz está escrito a mano**: cada
 * etiqueta sale del catálogo de traducciones (`messages/{idioma}.json`) con la misma clave que usa la aplicación, así que el mismo recorrido se hace entero
 * en castellano y en catalán. Las personas entran como lo harían de verdad: con el código de su email, con contraseña y la app de verificación, o con el
 * PIN de la puerta; los códigos se leen de `.email-preview/`.
 */

export type Lang = 'es' | 'ca';
export type T = (key: string, values?: Record<string, string | number>) => string;

export const NAVIGATION = { timeout: 45_000 };
export const server = expect.configure({ timeout: 30_000 });

/** Traductor del catálogo real de un idioma. Una clave que no exista rompe la prueba: no hay textos de reserva. */
export function translator(locale: Lang): T {
  const messages = JSON.parse(readFileSync(path.join(process.cwd(), 'messages', `${locale}.json`), 'utf8')) as Record<string, unknown>;
  const translate = createTranslator({
    locale,
    messages,
    onError: (error) => {
      throw error;
    }
  }) as unknown as T;
  return (key, values) => translate(key, values);
}

/** El castellano va sin prefijo; el catalán, con `/ca` (`localePrefix: 'as-needed'`). */
export const localized = (locale: Lang, route: string): string => (locale === 'es' ? route : `/${locale}${route}`);

const octet = () => 1 + Math.floor(Math.random() * 250);
/** Cada persona desde su propia red de prueba: los límites por red (altas, firmas, pagos, códigos) no deben mezclar a las personas de la suite. */
export const ownNetwork = () => ({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` });

/** Otro navegador (otra persona u otro dispositivo), con el mismo tamaño de pantalla que el proyecto. */
export async function newPerson(browser: Browser, like: Page, extra: Parameters<Browser['newContext']>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: like.viewportSize() ?? undefined, extraHTTPHeaders: ownNetwork(), ...extra });
  return { context, page: await context.newPage() };
}

/** Puerta 4 en cada pantalla: una columna en móvil, sin desbordes, sin claves sin traducir, sin incidencias serias de accesibilidad y con los encabezados en orden. */
export async function checkPage(page: Page, isMobile: boolean) {
  if (isMobile) await expectMobileStackIsOneColumn(page);
  await expectNoHorizontalOverflow(page);
  await expectNoMissingTranslations(page);
  await expectNoSeriousA11yViolations(page);
  await expectHeadingsInOrder(page);
  // Solo dice algo donde hay pizarra (el Estudio): sus filas se leen enteras.
  await expectBoardRowsReadable(page);
}

/** Código de 6 dígitos de un email, sin confundirlo con los dígitos de un enlace. */
export const otpIn = (text: string): string => /\b(\d{6})\b/.exec(text.split('\n\n').slice(1).join('\n').replace(/https?:\/\/\S+/g, ''))?.[1] ?? '';

export interface JourneyEntity {
  slug: string;
  name: string;
  legalName: string;
  director: string;
  cosigner: string;
  password: string;
  totpSecret: string;
  registeredAt: number;
}

/** Activa la app de verificación (TOTP) de quien acaba de crear su contraseña y devuelve su secreto. */
async function activateTotp(page: Page, t: T, password: string): Promise<string> {
  await server(page.getByRole('heading', { level: 1, name: t('auth.twoFactor.setupTitle') })).toBeVisible();
  await page.getByLabel(t('auth.twoFactor.password')).fill(password);
  await page.getByRole('button', { name: t('auth.twoFactor.start') }).click();
  await server(page.getByRole('img', { name: t('auth.twoFactor.qrAlt') })).toBeVisible();
  const secret = (await page.locator('code').first().innerText()).trim();
  await page.getByLabel(t('auth.twoFactor.backupSaved')).check();
  await page.getByLabel(t('auth.twoFactor.firstCode')).fill(totpCode(secret));
  await page.getByRole('button', { name: t('auth.twoFactor.confirm') }).click();
  return secret;
}

/**
 * Alta autónoma de una entidad por la interfaz, en el idioma del recorrido: 3 pasos, verificación del email y app de verificación. Con `ley49`, la entidad
 * declara estar acogida a la Ley 49/2002 (después deberá acreditarlo con su documento). Deja la sesión de quien dirige abierta en su panel.
 */
export async function registerEntity(page: Page, t: T, locale: Lang, options: { namePrefix: string; ley49: boolean }): Promise<JourneyEntity> {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const director = uniqueEmail('direccion');
  const cosigner = uniqueEmail('afa');
  const password = 'una-contraseña-muy-larga';
  const name = `${options.namePrefix} ${suffix}`;
  const legalName = `AFA ${options.namePrefix} ${suffix}`;
  await page.setExtraHTTPHeaders(ownNetwork());
  await page.goto(localized(locale, '/registro-comunidad'));
  await page.getByLabel(t('registration.fields.name')).fill(name);
  const slug = await page.getByLabel(t('registration.fields.slug')).inputValue();
  expect(slug).toMatch(/^[a-z0-9-]+$/);
  await page.getByLabel(t('registration.fields.province')).selectOption('08');
  await page.getByLabel(t('registration.fields.city')).fill('Sabadell');
  await page.getByLabel(t('registration.fields.postalCode')).fill('08201');
  await page.getByLabel(t('registration.fields.legalName')).fill(legalName);
  await page.getByLabel(t('registration.fields.legalForm')).selectOption('PARENTS_ASSOCIATION');
  if (options.ley49) await page.getByLabel(t('registration.fields.ley49')).check();
  await page.getByRole('button', { name: t('registration.continue') }).click();

  const signer = (index: number) => page.locator('fieldset').nth(index);
  await expect(page.getByRole('heading', { level: 2, name: t('registration.steps.signers') })).toBeFocused();
  await signer(0).getByLabel(t('registration.fields.personName')).fill('Carla Puig');
  await signer(0).getByLabel(t('registration.fields.email')).fill(director);
  await signer(0).getByLabel(t('registration.fields.phone')).fill('600 111 222');
  await signer(0).getByLabel(t('registration.fields.password'), { exact: true }).fill(password);
  await signer(0).getByLabel(t('registration.fields.passwordRepeat')).fill(password);
  await signer(1).getByLabel(t('registration.fields.personName')).fill('Marta Soler');
  await signer(1).getByLabel(t('registration.fields.email')).fill(cosigner);
  await signer(1).getByLabel(t('registration.fields.phone')).fill('600 333 444');
  await page.getByRole('button', { name: t('registration.continue') }).click();

  await page.getByLabel(t('registration.fields.representationDeclared', { legalName })).check();
  const registeredAt = Date.now();
  await page.getByRole('button', { name: t('registration.submit') }).click();
  await server(page.getByRole('heading', { name: t('registration.verify.title', { name }) })).toBeVisible();
  await page.getByLabel(t('registration.verify.code')).fill(await codeTo(director, registeredAt));
  await page.getByRole('button', { name: t('registration.verify.submit') }).click();
  const totpSecret = await activateTotp(page, t, password);
  await expect(page).toHaveURL(new RegExp(`${localized(locale, `/panel/${slug}`)}$`), { timeout: 30_000 });
  return { slug, name, legalName, director, cosigner, password, totpSecret, registeredAt };
}

/** La segunda persona firmante abre la invitación de su email en su propio navegador, crea su contraseña y activa su app de verificación. */
export async function activateCosigner(browser: Browser, like: Page, t: T, locale: Lang, entity: JourneyEntity): Promise<{ context: BrowserContext; page: Page; totpSecret: string }> {
  const invitation = await emailTo(entity.cosigner, entity.registeredAt);
  const link = /https?:\/\/\S+\/invitacion#t=\S+/.exec(invitation)?.[0];
  expect(link, 'enlace de la invitación').toBeTruthy();
  const url = new URL(link!);
  // El enlace va en el idioma de la persona invitada (el de la entidad al darse de alta).
  expect(url.pathname).toBe(localized(locale, '/invitacion'));
  const person = await newPerson(browser, like);
  await person.page.goto(url.pathname + url.hash);
  await person.page.getByLabel(t('auth.invitation.password')).fill(entity.password);
  await person.page.getByLabel(t('auth.invitation.repeat')).fill(entity.password);
  await person.page.getByRole('button', { name: t('auth.invitation.submit') }).click();
  const totpSecret = await activateTotp(person.page, t, entity.password);
  await server(person.page).toHaveURL(new RegExp(`${localized(locale, `/panel/${entity.slug}`)}$`));
  return { ...person, totpSecret };
}

/** La dirección termina exactamente en esta ruta (con sus parámetros). */
const endsWith = (route: string): RegExp => new RegExp(`${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/** Una familia entra con el código de 6 dígitos de su email y vuelve a la página que quería ver. */
export async function signInFamily(page: Page, t: T, locale: Lang, email: string, next: string) {
  await page.goto(`${localized(locale, '/login')}?next=${encodeURIComponent(next)}`);
  await page.getByLabel(t('auth.login.email')).fill(email);
  const since = Date.now();
  await page.getByRole('button', { name: t('auth.login.sendCode') }).click();
  await expect(page.getByRole('heading', { name: t('auth.login.steps.code') })).toBeFocused({ timeout: 30_000 });
  await page.getByLabel(t('auth.login.code')).fill(await codeTo(email, since));
  await page.getByRole('button', { name: t('auth.login.enter'), exact: true }).click();
  await server(page).toHaveURL(endsWith(next));
}

/** Quien firma por una entidad o gestiona KORUM entra con su contraseña y el código de su app de verificación. */
export async function signInStaff(page: Page, t: T, locale: Lang, account: { email: string; password: string; totpSecret: string }, next: string) {
  await page.goto(localized(locale, next));
  await page.getByRole('button', { name: t('auth.login.mode.password') }).click();
  await page.getByLabel(t('auth.login.email')).fill(account.email);
  await page.getByLabel(t('auth.login.password')).fill(account.password);
  await page.getByRole('button', { name: t('auth.login.enter'), exact: true }).click();
  await server(page.getByRole('heading', { name: t('auth.login.steps.second-factor') })).toBeVisible();
  await page.getByLabel(t('auth.secondFactor.code')).fill(totpCode(account.totpSecret));
  await page.getByRole('button', { name: t('auth.secondFactor.verify') }).click();
  await expect(page).toHaveURL(endsWith(localized(locale, next)), { timeout: 30_000 });
}

/** El enlace de firma (de un solo uso) y el código que acaban de llegar a una persona firmante para un asunto concreto (`about`: el título de la idea o campaña). */
export async function signingEmail(address: string, since: number, about: string): Promise<{ path: string; otp: string }> {
  const text = await emailTo(address, since, (body) => body.includes(about) && /\/firmar#t=/.test(body));
  const link = /https?:\/\/\S+\/firmar#t=[A-Za-z0-9_-]+/.exec(text)?.[0];
  const otp = otpIn(text);
  expect(link, 'enlace de firma').toBeTruthy();
  expect(otp, 'código de firma').toMatch(/^\d{6}$/);
  const url = new URL(link!);
  return { path: url.pathname + url.hash, otp };
}

/**
 * La persona de KORUM que revisa y actúa en la consola: una cuenta **sin ningún cargo en una entidad** (la aplicación no deja que quien firma por una entidad sea
 * Super-Admin). Nace como cualquier cuenta, con el código de su email; se le da el permiso de Super-Admin (lo único del recorrido que no sale de una pantalla:
 * en producción lo dan `npm run superadmin:bootstrap` para la primera persona y la invitación desde la consola para las demás); crea su contraseña con el
 * código de recuperación y activa su app de verificación, que la consola le exige antes de dejarle entrar.
 */
export async function createKorumReviewer(browser: Browser, like: Page, t: T, locale: Lang): Promise<{ context: BrowserContext; page: Page; email: string; password: string; totpSecret: string }> {
  const person = await newPerson(browser, like);
  const { page } = person;
  const email = uniqueEmail('equipo-korum');
  const password = 'otra-contraseña-muy-larga';
  await signInFamily(page, t, locale, email, localized(locale, '/mi-cuenta'));
  const granted = await withE2eDb((db) => db.query(`UPDATE "User" SET "isSuperadmin" = true WHERE lower("email") = lower($1) AND NOT EXISTS (SELECT 1 FROM "OrganizationMember" m WHERE m."userId" = "User".id)`, [email]));
  expect(granted.rowCount, 'la cuenta de KORUM no tiene cargos en ninguna entidad').toBe(1);
  await person.context.clearCookies();

  await page.goto(localized(locale, '/admin'));
  await page.getByRole('button', { name: t('auth.login.mode.password') }).click();
  await page.getByRole('button', { name: t('auth.login.forgot') }).click();
  await page.getByLabel(t('auth.login.email')).fill(email);
  const since = Date.now();
  await page.getByRole('button', { name: t('auth.login.sendResetCode') }).click();
  await page.getByLabel(t('auth.login.code')).fill(await codeTo(email, since));
  await page.getByLabel(t('auth.login.newPassword')).fill(password);
  await page.getByRole('button', { name: t('auth.login.savePassword') }).click();
  await server(page.getByText(t('auth.login.resetDone'))).toBeVisible();
  await page.getByLabel(t('auth.login.email')).fill(email);
  await page.getByLabel(t('auth.login.password'), { exact: true }).fill(password);
  await page.getByRole('button', { name: t('auth.login.enter'), exact: true }).click();
  const totpSecret = await activateTotp(page, t, password);
  await expect(page).toHaveURL(endsWith(localized(locale, '/admin')), { timeout: 30_000 });
  return { ...person, email, password, totpSecret };
}

/**
 * Abre el enlace de firma, comprueba qué se firma y firma con el código del email. `inspect` mira la pantalla de lo que se va a firmar antes de firmar. El enlace
 * se abre en la pestaña donde la persona ya tenía el panel, también si en ella seguía a la vista su firma anterior.
 */
export async function signWithEmailCode(page: Page, t: T, link: { path: string; otp: string }, about: string, inspect?: () => Promise<void>) {
  await page.goto(link.path);
  await server(page.getByText(about).first()).toBeVisible();
  // El enlace de un solo uso no se queda en la barra de direcciones.
  expect(new URL(page.url()).hash).toBe('');
  if (inspect) await inspect();
  await page.getByLabel(t('panel.sign.otpLabel')).fill(link.otp);
  await page.getByRole('button', { name: t('panel.sign.submit') }).click();
}

/** Lee de verdad el código QR que se ve en pantalla (como la cámara de la portería): captura el dibujo y lo descifra. */
export async function readQrCode(qr: Locator): Promise<string> {
  const { data, info } = await sharp(await qr.screenshot()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const decoded = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height);
  expect(decoded, 'el código QR del pase se puede leer').not.toBeNull();
  return decoded!.data;
}

export const pdfFile = (label: string) => ({ name: `${label}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1') });

/** Una foto de verdad (JPEG de 640 × 480 de un color): el servidor la reduce, le quita los metadatos y la publica. */
export async function photoFile(label: string, color: { r: number; g: number; b: number }) {
  const buffer = await sharp({ create: { width: 640, height: 480, channels: 3, background: color } }).jpeg({ quality: 80 }).toBuffer();
  return { name: `${label}.jpg`, mimeType: 'image/jpeg', buffer };
}
