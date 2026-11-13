import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretField } from '@/components/admin/settings/settings-secret-field';
import { CompanySettings, LegalSettings } from '@/components/admin/settings/settings-legal';
import { HistoryTable, SecurityPanel } from '@/components/admin/settings/settings-readonly';
import { AutoBoostSettings, EmailSettings, HuchaSettings, InvoicingSettings, LimitsSettings, PaymentsSettings } from '@/components/admin/settings/settings-sections';
import { SeoSettings } from '@/components/admin/settings/settings-seo';
import { TeamSettings } from '@/components/admin/settings/settings-team';
import { ToastProvider } from '@/components/ui/toast-provider';
import type { Locale } from '@/i18n/routing';
import type { HistoryRow, LegalOverviewRow, LegalSelected, SecurityView, SettingFieldView } from '@/services/admin/platform-settings-view';
import type { SecretSummary } from '@/services/settings/settings.service';
import { renderWithIntl } from '../utils/render-with-intl';

/** Sprint 5.4 · pantalla `/admin/ajustes` (QA-A05, QA-SEC07): secretos de solo escritura, confirmaciones en dos pasos, avisos con texto, foco y los tres idiomas. */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, prefetch: _prefetch, ...props }: { href: string | { pathname: string }; children: ReactNode; prefetch?: boolean }) => (
    <a href={typeof href === 'string' ? href : href.pathname} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({ refresh: vi.fn() })
}));
const actions = {
  saveSectionAction: vi.fn(),
  saveSecretAction: vi.fn(),
  removeSecretAction: vi.fn(),
  saveLegalTextAction: vi.fn(),
  inviteSuperadminAction: vi.fn(),
  cancelSuperadminInvitationAction: vi.fn(),
  revokeSuperadminAction: vi.fn(),
  testConnectionAction: vi.fn()
};
vi.mock('@/app/[locale]/(superadmin)/admin/ajustes/actions', () => ({
  saveSectionAction: (...args: unknown[]) => actions.saveSectionAction(...args),
  saveSecretAction: (...args: unknown[]) => actions.saveSecretAction(...args),
  removeSecretAction: (...args: unknown[]) => actions.removeSecretAction(...args),
  saveLegalTextAction: (...args: unknown[]) => actions.saveLegalTextAction(...args),
  inviteSuperadminAction: (...args: unknown[]) => actions.inviteSuperadminAction(...args),
  cancelSuperadminInvitationAction: (...args: unknown[]) => actions.cancelSuperadminInvitationAction(...args),
  revokeSuperadminAction: (...args: unknown[]) => actions.revokeSuperadminAction(...args),
  testConnectionAction: (...args: unknown[]) => actions.testConnectionAction(...args)
}));

/** Una clave de traducción sin resolver no rompe el render (next-intl pinta la clave y avisa por consola): se vigila aquí. */
let consoleErrors: { mock: { calls: unknown[][] } };
beforeEach(() => {
  consoleErrors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  actions.saveSectionAction.mockResolvedValue({ status: 'DONE', detail: '1' });
  actions.saveSecretAction.mockResolvedValue({ status: 'DONE' });
  actions.removeSecretAction.mockResolvedValue({ status: 'DONE' });
  actions.saveLegalTextAction.mockResolvedValue({ status: 'DONE', detail: '2026-11-13' });
  actions.inviteSuperadminAction.mockResolvedValue({ status: 'DONE' });
  actions.cancelSuperadminInvitationAction.mockResolvedValue({ status: 'DONE' });
  actions.revokeSuperadminAction.mockResolvedValue({ status: 'DONE' });
});
afterEach(() => {
  const missing = consoleErrors.mock.calls.map((call: unknown[]) => String(call[0])).filter((message: string) => message.includes('MISSING_MESSAGE'));
  expect(missing).toEqual([]);
  vi.clearAllMocks();
});

const renderAll = (node: ReactNode, locale: Locale = 'es') => renderWithIntl(<ToastProvider>{node}</ToastProvider>, locale);

const field = (value: unknown, version = 0, source: SettingFieldView['source'] = 'console'): SettingFieldView => ({ value, version, source });
const FIELDS: Record<string, SettingFieldView> = {
  'paycomet.merchantCode': field('KORUM-COMERCIO', 3),
  'paycomet.terminalId': field('12345', 2),
  'paycomet.jetId': field(null, 0, 'none'),
  'paycomet.serverIp': field(null, 0, 'none'),
  'email.provider': field('brevo', 0, 'default'),
  'email.fromAddress': field('hola@korum.test', 1),
  'email.fromName': field('KORUM', 0, 'default'),
  'email.replyTo': field(null, 0, 'none'),
  'invoicing.provider': field(null, 0, 'none'),
  'invoicing.issuerNif': field(null, 0, 'none'),
  'invoicing.issuerName': field(null, 0, 'none'),
  'invoicing.series': field(null, 0, 'none'),
  'hucha.mode': field('PLEDGE', 0, 'default'),
  'hucha.walletProvider': field(null, 0, 'none'),
  'autoBoost.publicDisclosureDefault': field('SHOW', 0, 'default'),
  'seo.aiCrawlers': field(null, 0, 'none'),
  'seo.verification.google': field(null, 0, 'none'),
  'seo.verification.bing': field(null, 0, 'none'),
  'platform.company': field(null, 0, 'none'),
  'raffle.extraRoundMinHours': field(0, 0, 'default')
};
const secret = (key: string, over: Partial<SecretSummary> = {}): SecretSummary => ({ key: key as SecretSummary['key'], configured: false, hint: null, usesEnvFallback: false, updatedAt: null, ...over });
const SECRETS: Record<string, SecretSummary> = {
  'paycomet.apiKey': secret('paycomet.apiKey', { configured: true, hint: 'ZZZZ', updatedAt: new Date('2026-11-12T10:30:00Z') }),
  'paycomet.webhookSecret': secret('paycomet.webhookSecret', { configured: true, usesEnvFallback: true }),
  'email.apiKey': secret('email.apiKey'),
  'invoicing.apiKey': secret('invoicing.apiKey'),
  'hucha.walletApiKey': secret('hucha.walletApiKey'),
  'seo.indexNowKey': secret('seo.indexNowKey')
};

describe('QA-SEC07 · secretos de solo escritura', () => {
  it('dice si está guardada, de dónde sale y los 4 últimos caracteres, nunca el valor; el campo es de contraseña y no se autocompleta', () => {
    renderAll(<SecretField secretKey="paycomet.apiKey" summary={SECRETS['paycomet.apiKey']} />);
    expect(screen.getByTestId('secret-status-paycomet.apiKey').textContent).toMatch(/Guardada en la consola · termina en «ZZZZ» · actualizada el/);
    const input = screen.getByLabelText('Clave de la API de Paycomet') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('new-password');
    expect(input.value).toBe('');
    expect(screen.getByTestId('secret-save-paycomet.apiKey')).toHaveAttribute('aria-disabled', 'true');
  });

  it('con la clave de respaldo del servidor y sin configurar lo dice con texto, y solo ofrece «Quitar» si hay clave en la consola', () => {
    const { unmount } = renderAll(<SecretField secretKey="paycomet.webhookSecret" summary={SECRETS['paycomet.webhookSecret']} />);
    expect(screen.getByTestId('secret-status-paycomet.webhookSecret').textContent).toBe('No hay clave en la consola: se usa la clave de respaldo del servidor.');
    expect(screen.queryByTestId('secret-remove-paycomet.webhookSecret')).toBeNull();
    unmount();
    renderAll(<SecretField secretKey="email.apiKey" summary={SECRETS['email.apiKey']} />);
    expect(screen.getByTestId('secret-status-email.apiKey').textContent).toBe('Sin configurar.');
    expect(screen.queryByTestId('secret-remove-email.apiKey')).toBeNull();
  });

  it('guardar manda la clave y su valor al servidor, vacía el campo y no deja el valor en la página', async () => {
    const user = userEvent.setup();
    renderAll(<SecretField secretKey="paycomet.apiKey" summary={SECRETS['paycomet.apiKey']} />);
    const input = screen.getByLabelText('Clave de la API de Paycomet') as HTMLInputElement;
    await user.type(input, 'sk-nueva-clave-0123456789');
    await user.click(screen.getByTestId('secret-save-paycomet.apiKey'));
    await waitFor(() => expect(actions.saveSecretAction).toHaveBeenCalledWith({ key: 'paycomet.apiKey', value: 'sk-nueva-clave-0123456789' }));
    await waitFor(() => expect(input.value).toBe(''));
    expect(document.body.textContent).not.toContain('sk-nueva-clave-0123456789');
  });

  it('quitar pide una confirmación aparte con su aviso; cancelar no hace nada y confirmar la quita', async () => {
    const user = userEvent.setup();
    renderAll(<SecretField secretKey="paycomet.apiKey" summary={SECRETS['paycomet.apiKey']} />);
    await user.click(screen.getByTestId('secret-remove-paycomet.apiKey'));
    const group = screen.getByRole('group', { name: 'Quitar Clave de la API de Paycomet' });
    expect(within(group).getByText(/el servicio que la necesita dejará de funcionar/)).toBeTruthy();
    await user.click(within(group).getByRole('button', { name: 'Cancelar' }));
    expect(actions.removeSecretAction).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('secret-remove-paycomet.apiKey'));
    await user.click(screen.getByTestId('secret-remove-yes-paycomet.apiKey'));
    await waitFor(() => expect(actions.removeSecretAction).toHaveBeenCalledWith({ key: 'paycomet.apiKey' }));
  });

  it('un rechazo del servidor se anuncia junto al campo (role=alert) y, si caducó el segundo factor, enlaza a confirmarlo', async () => {
    const user = userEvent.setup();
    actions.saveSecretAction.mockResolvedValue({ status: 'REAUTH_REQUIRED' });
    renderAll(<SecretField secretKey="email.apiKey" summary={SECRETS['email.apiKey']} />);
    await user.type(screen.getByLabelText('Clave de la API de Brevo'), 'una-clave-larga-1234567');
    await user.click(screen.getByTestId('secret-save-email.apiKey'));
    const alert = await screen.findByTestId('settings-outcome');
    expect(alert.textContent).toMatch(/Han pasado más de 10 minutos/);
    expect(within(alert).getByRole('link', { name: 'Volver a confirmar mi segundo factor' })).toBeTruthy();
  });
});

describe('QA-A05 · cobros, email, facturación y Mi Hucha', () => {
  it('los cobros enseñan el modo del servidor con texto, avisan si falta la IP con cobros de pruebas y guardan solo los campos del bloque con su versión', async () => {
    const user = userEvent.setup();
    renderAll(<PaymentsSettings fields={FIELDS} secrets={SECRETS} mode="sandbox" />);
    expect(screen.getByTestId('paycomet-mode').textContent).toMatch(/Modo de cobros: pruebas \(sandbox\)\./);
    expect(screen.getByRole('note').textContent).toMatch(/Falta la IP pública del servidor/);
    await user.type(screen.getByLabelText('IP pública del servidor'), '203.0.113.7');
    await user.click(screen.getByTestId('save-pagos'));
    await waitFor(() => expect(actions.saveSectionAction).toHaveBeenCalledTimes(1));
    expect(actions.saveSectionAction).toHaveBeenCalledWith({
      section: 'pagos',
      values: { 'paycomet.merchantCode': 'KORUM-COMERCIO', 'paycomet.terminalId': '12345', 'paycomet.jetId': '', 'paycomet.serverIp': '203.0.113.7' },
      versions: { 'paycomet.merchantCode': 3, 'paycomet.terminalId': 2, 'paycomet.jetId': 0, 'paycomet.serverIp': 0 },
      confirmations: []
    });
  });

  it('con el simulador no avisa de la IP; los dos secretos de Paycomet y «Probar conexión» están en el bloque', () => {
    renderAll(<PaymentsSettings fields={FIELDS} secrets={SECRETS} mode="mock" />);
    expect(screen.queryByText(/Falta la IP pública/)).toBeNull();
    expect(screen.getByTestId('secret-paycomet.apiKey')).toBeTruthy();
    expect(screen.getByTestId('secret-paycomet.webhookSecret')).toBeTruthy();
    expect(screen.getByTestId('test-paycomet-button')).toBeTruthy();
  });

  it('un valor de respaldo del servidor se dice con texto y un rechazo del servidor marca el campo y lleva el foco a él', async () => {
    const user = userEvent.setup();
    actions.saveSectionAction.mockResolvedValue({ status: 'REJECTED', reason: 'INVALID', fields: ['paycomet.terminalId'] });
    renderAll(<PaymentsSettings fields={{ ...FIELDS, 'paycomet.merchantCode': field('RESPALDO', 0, 'env') }} secrets={SECRETS} mode="mock" />);
    expect(screen.getByText(/Ahora se usa el valor de respaldo del servidor/)).toBeTruthy();
    await user.click(screen.getByTestId('save-pagos'));
    const alert = await screen.findByTestId('settings-outcome');
    expect(alert.textContent).toBe('Hay un valor que no es válido. Revisa: Terminal.');
    const terminal = screen.getByLabelText('Terminal');
    await waitFor(() => expect(terminal).toHaveFocus());
    expect(terminal).toHaveAttribute('aria-invalid', 'true');
  });

  it('otra persona guardó antes (STALE): lo dice y ofrece recargar', async () => {
    const user = userEvent.setup();
    actions.saveSectionAction.mockResolvedValue({ status: 'REJECTED', reason: 'STALE', fields: ['email.fromName'] });
    renderAll(<EmailSettings fields={FIELDS} secrets={SECRETS} />);
    await user.click(screen.getByTestId('save-email'));
    const alert = await screen.findByTestId('settings-outcome');
    expect(alert.textContent).toMatch(/Otra persona ha guardado estos ajustes/);
    expect(within(alert).getByRole('button', { name: 'Recargar la página' })).toBeTruthy();
  });

  it('el email avisa de que SMTP no tiene adaptador y no lo ofrece como proveedor', () => {
    renderAll(<EmailSettings fields={FIELDS} secrets={SECRETS} />);
    expect(screen.getByText(/La conexión directa con tu proveedor de correo aún no está disponible/)).toBeTruthy();
    const select = screen.getByLabelText('Proveedor de email') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['brevo']);
  });

  it('Veri*factu avisa en cada caso: sin ninguno, con uno solo y con los dos (el aviso cambia al escribir)', async () => {
    const user = userEvent.setup();
    renderAll(<InvoicingSettings fields={FIELDS} secrets={SECRETS} />);
    const warning = screen.getByTestId('invoicing-warning');
    expect(warning.textContent).toMatch(/Faltan el NIF y la razón social del emisor/);
    await user.type(screen.getByLabelText('NIF o CIF del emisor'), 'B12345674');
    expect(warning.textContent).toMatch(/Falta uno de los dos datos/);
    await user.type(screen.getByLabelText('Razón social del emisor'), 'KORUM Tecnología S.L.');
    expect(warning.textContent).toMatch(/NIF y razón social completos/);
  });

  it('Mi Hucha: la confirmación del monedero con saldo solo aparece al pasar a ese modo y sin ella no se envía; con ella se manda expresa', async () => {
    const user = userEvent.setup();
    renderAll(<HuchaSettings fields={FIELDS} secrets={SECRETS} />);
    expect(screen.getByTestId('hucha-mode-help').textContent).toMatch(/No hay saldo guardado/);
    expect(screen.queryByTestId('hucha-wallet-confirm')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Modo de Mi Hucha'), 'REGULATED_WALLET');
    expect(screen.getByTestId('hucha-mode-help').textContent).toMatch(/lo custodia una entidad autorizada/);
    await user.type(screen.getByLabelText('Entidad que custodia el saldo'), 'Mangopay');
    await user.click(screen.getByTestId('save-hucha'));
    await waitFor(() => expect(actions.saveSectionAction).toHaveBeenCalledTimes(1));
    expect(actions.saveSectionAction.mock.calls[0]![0]).toMatchObject({ section: 'hucha', confirmations: [] });
    await user.click(screen.getByTestId('hucha-wallet-confirm'));
    await user.click(screen.getByTestId('save-hucha'));
    await waitFor(() => expect(actions.saveSectionAction).toHaveBeenCalledTimes(2));
    expect(actions.saveSectionAction.mock.calls[1]![0]).toMatchObject({ section: 'hucha', values: { 'hucha.mode': 'REGULATED_WALLET', 'hucha.walletProvider': 'Mangopay' }, confirmations: ['walletLegal'] });
  });

  it('Auto-Impulso y límites: el límite editable se guarda como texto y los fijos se listan solo de lectura con su ventana', async () => {
    const user = userEvent.setup();
    const { unmount } = renderAll(<AutoBoostSettings fields={FIELDS} />);
    await user.selectOptions(screen.getByLabelText('Aviso público por defecto'), 'HIDE');
    await user.click(screen.getByTestId('save-autoimpulso'));
    await waitFor(() => expect(actions.saveSectionAction).toHaveBeenCalledWith(expect.objectContaining({ section: 'autoimpulso', values: { 'autoBoost.publicDisclosureDefault': 'HIDE' } })));
    unmount();
    renderAll(<LimitsSettings fields={FIELDS} fixedLimits={[{ id: 'authEmail', limit: 5, windowMs: 900_000 }, { id: 'registration', limit: 5, windowMs: 3_600_000 }, { id: 'webhookInvalid', limit: 60, windowMs: 60_000 }]} />);
    const table = screen.getByTestId('fixed-limits');
    expect(within(table).getByText('15 minutos')).toBeTruthy();
    expect(within(table).getByText('1 hora')).toBeTruthy();
    expect(within(table).getByText('1 minuto')).toBeTruthy();
    expect(within(table).queryAllByRole('textbox')).toHaveLength(0);
    await user.clear(screen.getByLabelText('Horas de espera antes de una ronda extra del sorteo'));
    await user.type(screen.getByLabelText('Horas de espera antes de una ronda extra del sorteo'), '24');
    await user.click(screen.getByTestId('save-limites'));
    await waitFor(() => expect(actions.saveSectionAction).toHaveBeenLastCalledWith(expect.objectContaining({ section: 'limites', values: { 'raffle.extraRoundMinHours': '24' } })));
  });
});

describe('QA-A05 · «Probar conexión»', () => {
  it.each([
    [{ status: 'RESULT', result: { status: 'OK' } }, /Conexión correcta/],
    [{ status: 'RESULT', result: { status: 'SIMULATED' } }, /modo simulador: no se llama a Paycomet/],
    [{ status: 'RESULT', result: { status: 'NOT_CONFIGURED', missing: ['paycomet.serverIp', 'paycomet.apiKey'] } }, /Falta por configurar: IP pública del servidor, Clave de la API de Paycomet\./],
    [{ status: 'RESULT', result: { status: 'FAILED', code: '1004' } }, /no ha aceptado la conexión \(código 1004\)/],
    [{ status: 'RESULT', result: { status: 'RATE_LIMITED' } }, /Demasiadas pruebas seguidas/],
    [{ status: 'REAUTH_REQUIRED' }, /Han pasado más de 10 minutos/]
  ])('%j se dice con texto y en una región que se anuncia', async (response, expected) => {
    const user = userEvent.setup();
    actions.testConnectionAction.mockResolvedValue(response);
    renderAll(<PaymentsSettings fields={FIELDS} secrets={SECRETS} mode="sandbox" />);
    const result = screen.getByTestId('test-paycomet-result');
    expect(result).toHaveAttribute('role', 'status');
    expect(result).toHaveAttribute('aria-live', 'polite');
    await user.click(screen.getByTestId('test-paycomet-button'));
    await waitFor(() => expect(result.textContent).toMatch(expected));
    expect(actions.testConnectionAction).toHaveBeenCalledWith('paycomet');
  });

  it('un fallo inesperado del servidor tampoco se queda mudo', async () => {
    const user = userEvent.setup();
    actions.testConnectionAction.mockRejectedValue(new Error('boom'));
    renderAll(<EmailSettings fields={FIELDS} secrets={SECRETS} />);
    await user.click(screen.getByTestId('test-email-button'));
    await waitFor(() => expect(screen.getByTestId('test-email-result').textContent).toMatch(/No se ha podido guardar/));
  });
});

const crawlers = { search: [{ userAgent: 'PerplexityBot', allow: true }], training: [{ userAgent: 'GPTBot', allow: true }] };

describe('QA-SEC07 · buscadores y asistentes de IA', () => {
  it('un nombre con espacios o símbolos o repetido no se puede añadir (se explica con texto) y uno válido sí', async () => {
    const user = userEvent.setup();
    renderAll(<SeoSettings fields={FIELDS} secrets={SECRETS} defaultPolicy={crawlers} />);
    const group = within(screen.getByTestId('crawlers-search'));
    const input = group.getByLabelText('Añadir un rastreador (nombre del agente)');
    const add = group.getByRole('button', { name: 'Añadir' });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    await user.type(input, 'Mi Bot');
    expect(group.getByRole('status').textContent).toMatch(/solo puede llevar letras, cifras, punto, guion y guion bajo/);
    expect(add).toHaveAttribute('aria-disabled', 'true');
    await user.clear(input);
    await user.type(input, 'gptbot');
    expect(group.getByRole('status').textContent).toBe('Ese rastreador ya está en la lista.');
    expect(add).toHaveAttribute('aria-disabled', 'true');
    await user.clear(input);
    await user.type(input, 'Claude-SearchBot');
    expect(add).toHaveAttribute('aria-disabled', 'false');
    await user.click(add);
    expect(group.getByRole('checkbox', { name: /Claude-SearchBot/ })).toBeChecked();
    // Se dice que se ha añadido y que falta guardar (la fila no tiene otro aviso).
    expect(group.getByRole('status').textContent).toBe('Claude-SearchBot añadido a la lista (falta guardar).');
    expect(screen.getByTestId('crawlers-dirty')).toBeTruthy();
  });

  it('solo manda la política si se ha tocado; al quitar y bloquear la manda entera junto a los códigos de verificación', async () => {
    const user = userEvent.setup();
    renderAll(<SeoSettings fields={FIELDS} secrets={SECRETS} defaultPolicy={crawlers} />);
    await user.type(screen.getByLabelText('Verificación de Google'), 'abcDEF123_-xyz');
    await user.click(screen.getByTestId('save-seo'));
    await waitFor(() => expect(actions.saveSectionAction).toHaveBeenCalledTimes(1));
    expect((actions.saveSectionAction.mock.calls[0]![0] as { values: Record<string, unknown> }).values).not.toHaveProperty('seo.aiCrawlers');

    await user.click(screen.getByRole('checkbox', { name: /GPTBot/ }));
    await user.click(screen.getByRole('button', { name: 'Quitar a PerplexityBot de la lista' }));
    await user.click(screen.getByTestId('save-seo'));
    await waitFor(() => expect(actions.saveSectionAction).toHaveBeenCalledTimes(2));
    expect((actions.saveSectionAction.mock.calls[1]![0] as { values: Record<string, unknown>; versions: Record<string, number> }).values['seo.aiCrawlers']).toEqual({ search: [], training: [{ userAgent: 'GPTBot', allow: false }] });
    expect(screen.getByTestId('secret-seo.indexNowKey')).toBeTruthy();
  });
});

const OVERVIEW: LegalOverviewRow[] = (['terminos', 'privacidad', 'cookies', 'aviso-legal'] as const).flatMap((document) =>
  (['es', 'ca', 'en'] as const).map((locale) => ({ document, locale, version: document === 'terminos' && locale === 'es' ? '2026-11-13' : null, status: document === 'terminos' && locale === 'es' ? ('PUBLICADO' as const) : null, characters: 10, settingVersion: document === 'terminos' && locale === 'es' ? 2 : 0 }))
);
const PUBLISHED: LegalSelected = { document: 'terminos', locale: 'es', settingVersion: 2, text: { version: '2026-11-13', status: 'PUBLICADO', markdown: '# Términos\n\nTexto vigente.' } };
const EMPTY_TEXT: LegalSelected = { document: 'cookies', locale: 'ca', settingVersion: 0, text: null };

describe('QA-A05 · textos legales y datos de la empresa', () => {
  it('la matriz lista las doce combinaciones con su versión y estado y marca la que se edita', () => {
    renderAll(<LegalSettings overview={OVERVIEW} selected={PUBLISHED} policyVersion="2026-11-01" suggestedVersion="2026-11-13.1" />);
    const matrix = within(screen.getByTestId('legal-matrix'));
    expect(matrix.getAllByRole('row')).toHaveLength(5);
    const current = screen.getByTestId('legal-terminos-es');
    expect(current).toHaveAttribute('aria-current', 'true');
    // El nombre accesible empieza por el contexto (documento e idioma, solo para lectores de pantalla) y termina con lo que se ve.
    expect(current.textContent).toBe('Términos y condiciones en Castellano: 2026-11-13 Publicado');
    expect(within(current).getByText('2026-11-13').textContent).toBe('2026-11-13');
    expect(screen.getByTestId('legal-cookies-ca').textContent).toBe('Política de cookies en Catalán: Sin crear');
    expect(screen.getByTestId('policy-version').textContent).toMatch(/2026-11-01/);
  });

  it('un texto publicado propone la versión siguiente, no deja volver a borrador y pide una confirmación aparte antes de publicar', async () => {
    const user = userEvent.setup();
    renderAll(<LegalSettings overview={OVERVIEW} selected={PUBLISHED} policyVersion="2026-11-01" suggestedVersion="2026-11-13.1" />);
    expect((screen.getByTestId('legal-version') as HTMLInputElement).value).toBe('2026-11-13.1');
    expect(screen.getByRole('radio', { name: 'Borrador' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Publicado' })).toBeChecked();
    // Sin cambiar el texto no hay nada que publicar (se dice con texto y no se abre la confirmación).
    expect(screen.getByTestId('legal-save')).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByTestId('legal-save'));
    expect(screen.getByText(/No hay cambios en el texto/)).toBeTruthy();
    expect(screen.queryByRole('group', { name: /Vas a publicar/ })).toBeNull();
    await user.type(screen.getByTestId('legal-markdown'), ' Y más.');
    await user.click(screen.getByTestId('legal-save'));
    expect(actions.saveLegalTextAction).not.toHaveBeenCalled();
    const group = screen.getByRole('group', { name: /Vas a publicar la versión 2026-11-13\.1 \(Castellano\)/ });
    await user.click(within(group).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('group', { name: /Vas a publicar/ })).toBeNull();
    await user.click(screen.getByTestId('legal-save'));
    await user.click(screen.getByTestId('legal-confirm'));
    await waitFor(() => expect(actions.saveLegalTextAction).toHaveBeenCalledWith({ document: 'terminos', locale: 'es', version: '2026-11-13.1', status: 'PUBLICADO', markdown: '# Términos\n\nTexto vigente. Y más.', expectedVersion: 2 }));
  });

  it('un texto nuevo se guarda como borrador sin confirmación y sin texto no se puede guardar', async () => {
    const user = userEvent.setup();
    renderAll(<LegalSettings overview={OVERVIEW} selected={EMPTY_TEXT} policyVersion="2026-11-01" suggestedVersion="2026-11-13" />);
    const save = screen.getByTestId('legal-save');
    expect(save).toHaveAttribute('aria-disabled', 'true');
    await user.type(screen.getByTestId('legal-markdown'), 'Galetes');
    expect(save.textContent).toBe('Guardar borrador');
    await user.click(save);
    await waitFor(() => expect(actions.saveLegalTextAction).toHaveBeenCalledWith({ document: 'cookies', locale: 'ca', version: '2026-11-13', status: 'BORRADOR', markdown: 'Galetes', expectedVersion: 0 }));
    // El texto en otro idioma que el de la pantalla se marca con su idioma para los lectores de pantalla.
    expect(screen.getByTestId('legal-markdown')).toHaveAttribute('lang', 'ca');
  });

  it('un rechazo de versión se dice con su texto y marca el campo de la versión', async () => {
    const user = userEvent.setup();
    actions.saveLegalTextAction.mockResolvedValue({ status: 'REJECTED', reason: 'VERSION_OLDER', fields: ['version'] });
    renderAll(<LegalSettings overview={OVERVIEW} selected={EMPTY_TEXT} policyVersion="2026-11-01" suggestedVersion="2026-11-13" />);
    await user.type(screen.getByTestId('legal-markdown'), 'Texto');
    await user.click(screen.getByTestId('legal-save'));
    const alert = await screen.findByTestId('settings-outcome');
    expect(alert.textContent).toMatch(/La versión no puede ser anterior a la guardada\. Revisa:/);
    expect(screen.getByTestId('legal-version')).toHaveAttribute('aria-invalid', 'true');
  });

  it('los datos de la empresa se guardan juntos y, con todos los campos vacíos, se borran', async () => {
    const user = userEvent.setup();
    renderAll(<CompanySettings field={field({ legalName: 'KORUM Tecnología S.L.', taxId: 'B12345674', address: 'Calle Mayor 1', supportEmail: 'soporte@korum.test', privacyEmail: 'privacidad@korum.test' }, 4)} />);
    expect((screen.getByLabelText('Razón social') as HTMLInputElement).value).toBe('KORUM Tecnología S.L.');
    await user.clear(screen.getByLabelText('Email de soporte'));
    await user.type(screen.getByLabelText('Email de soporte'), 'ayuda@korum.test');
    await user.click(screen.getByTestId('save-empresa'));
    await waitFor(() => expect(actions.saveSectionAction).toHaveBeenCalledWith({ section: 'empresa', values: { 'platform.company': { legalName: 'KORUM Tecnología S.L.', taxId: 'B12345674', address: 'Calle Mayor 1', supportEmail: 'ayuda@korum.test', privacyEmail: 'privacidad@korum.test' } }, versions: { 'platform.company': 4 }, confirmations: [] }));
    for (const label of ['Razón social', 'NIF o CIF', 'Domicilio', 'Email de soporte', 'Email de privacidad']) await user.clear(screen.getByLabelText(label));
    await user.click(screen.getByTestId('save-empresa'));
    await waitFor(() => expect(actions.saveSectionAction).toHaveBeenLastCalledWith(expect.objectContaining({ values: { 'platform.company': null } })));
  });
});

const NOW = new Date('2026-11-13T10:00:00Z');
const MEMBERS = [
  { id: 'yo', email: 'yo@korum.test', twoFactorEnabled: true, isYou: true, lastSeenAt: NOW },
  { id: 'otra', email: 'otra@korum.test', twoFactorEnabled: false, isYou: false, lastSeenAt: null }
];
const INVITATIONS = [
  { userId: 'nueva', email: 'nueva@korum.test', expiresAt: new Date('2026-11-16T10:00:00Z'), expired: false },
  { userId: 'vieja', email: 'vieja@korum.test', expiresAt: new Date('2026-11-01T10:00:00Z'), expired: true }
];

describe('QA-SEC07 · equipo con acceso', () => {
  it('a uno mismo no se le ofrece retirar el acceso; a otra persona sí, con confirmación aparte que dice qué pasará', async () => {
    const user = userEvent.setup();
    renderAll(<TeamSettings members={MEMBERS} invitations={[]} />);
    const rows = screen.getAllByTestId('team-member');
    expect(within(rows[0]!).queryByTestId('team-revoke')).toBeNull();
    expect(within(rows[0]!).getByText(/Nadie puede quitarse el acceso a sí mismo/)).toBeTruthy();
    expect(rows[0]!.textContent).toMatch(/yo@korum\.test \(tú\)/);
    expect(rows[1]!.textContent).toMatch(/Sin segundo factor/);
    await user.click(within(rows[1]!).getByTestId('team-revoke'));
    const group = within(within(rows[1]!).getByRole('group', { name: 'Retirar el acceso a otra@korum.test' }));
    expect(group.getByText(/se cerrarán todas sus sesiones ahora mismo/)).toBeTruthy();
    expect(actions.revokeSuperadminAction).not.toHaveBeenCalled();
    await user.click(group.getByTestId('team-revoke-yes'));
    await waitFor(() => expect(actions.revokeSuperadminAction).toHaveBeenCalledWith({ userId: 'otra' }));
  });

  it('invita con el email y el idioma de la pantalla, vacía el campo y lista las pendientes con volver a enviar y anular (también las caducadas)', async () => {
    const user = userEvent.setup();
    renderAll(<TeamSettings members={MEMBERS} invitations={INVITATIONS} />, 'ca');
    const invites = screen.getAllByTestId('team-invitation');
    expect(invites).toHaveLength(2);
    expect(invites[1]!.textContent).toMatch(/Va caducar el/);
    await user.click(within(invites[1]!).getByRole('button', { name: 'Tornar a enviar la invitació a vieja@korum.test' }));
    await waitFor(() => expect(actions.inviteSuperadminAction).toHaveBeenCalledWith({ email: 'vieja@korum.test', locale: 'ca' }));
    // Anular pide una confirmación aparte (con el foco en «Cancel·lar»).
    await user.click(within(invites[0]!).getByRole('button', { name: 'Anul·lar la invitació de nueva@korum.test' }));
    expect(actions.cancelSuperadminInvitationAction).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('team-cancel-invitation-yes'));
    await waitFor(() => expect(actions.cancelSuperadminInvitationAction).toHaveBeenCalledWith({ userId: 'nueva' }));
    const email = screen.getByTestId('team-invite-email') as HTMLInputElement;
    await user.type(email, 'persona@korum.test');
    await user.click(screen.getByTestId('team-invite-send'));
    await waitFor(() => expect(actions.inviteSuperadminAction).toHaveBeenCalledWith({ email: 'persona@korum.test', locale: 'ca' }));
    await waitFor(() => expect(email.value).toBe(''));
  });

  it('un rechazo del servidor al invitar se dice con su motivo y deja el foco en el campo del email', async () => {
    const user = userEvent.setup();
    actions.inviteSuperadminAction.mockResolvedValue({ status: 'REJECTED', reason: 'ENTITY_MEMBER', fields: [] });
    renderAll(<TeamSettings members={MEMBERS} invitations={[]} />);
    await user.type(screen.getByTestId('team-invite-email'), 'firma@korum.test');
    await user.click(screen.getByTestId('team-invite-send'));
    expect((await screen.findByTestId('settings-outcome')).textContent).toBe('Esa cuenta firma por una entidad y no puede ser Super-Admin: usa otro email.');
    await waitFor(() => expect(screen.getByTestId('team-invite-email')).toHaveFocus());
  });
});

const SECURITY: SecurityView = { keyVersion: 2, previousKeys: 1, pending: { PlatformSecret: 0, Contribution: 3, User: 0 }, pendingTotal: 3, alerts: { CARD_DELETE_FAILED: 1, PRIVACY_REQUEST_OVERDUE: 0, ENCRYPTION_KEY_MISSING: 0 } };

describe('QA-A05 · claves de cifrado e historial', () => {
  it.each([
    [{ ...SECURITY }, 'rotating', /La rotación está en marcha/],
    [{ ...SECURITY, pending: {}, pendingTotal: 0 }, 'readyToRetire', /ya puedes vaciar ENCRYPTION_PREVIOUS_KEYS/],
    [{ ...SECURITY, previousKeys: 0 }, 'orphaned', /que no está entre las configuradas/],
    [{ ...SECURITY, previousKeys: 0, pending: {}, pendingTotal: 0 }, 'ok', /nada que hacer/]
  ])('el estado de la rotación (%#) se explica con texto', (security, state, expected) => {
    renderAll(<SecurityPanel security={security} />);
    expect(screen.getByTestId('rotation-state').textContent).toMatch(expected);
    void state;
  });

  it('lista lo pendiente solo de las tablas que tienen algo y enlaza a las alertas solo si hay abiertas', () => {
    renderAll(<SecurityPanel security={SECURITY} />);
    expect(screen.getByTestId('pending-total').textContent).toBe('3');
    expect(screen.getByText('NIF de donantes: 3')).toBeTruthy();
    expect(screen.queryByText(/Claves de la consola: 0/)).toBeNull();
    expect(within(screen.getByTestId('security-alert-CARD_DELETE_FAILED')).getByRole('link', { name: 'Ver en las alertas' })).toHaveAttribute('href', '/admin#avisos');
    expect(within(screen.getByTestId('security-alert-ENCRYPTION_KEY_MISSING')).queryByRole('link')).toBeNull();
    expect(within(screen.getByTestId('security-alert-ENCRYPTION_KEY_MISSING')).getByText('Ninguna abierta')).toBeTruthy();
  });

  it('el historial muestra quién, cuándo, qué y el detalle (versión, valor corto, texto legal, conexión, sesiones); sin nada, lo dice', () => {
    const rows: HistoryRow[] = [
      { id: 5, occurredAt: NOW, action: 'settings.setting.updated', target: 'raffle.extraRoundMinHours', actorEmail: 'yo@korum.test', version: 3, value: '48', legal: null, status: null, sessionsClosed: null, walletConfirmed: false },
      { id: 4, occurredAt: NOW, action: 'settings.setting.updated', target: 'legal.terminos.es', actorEmail: 'yo@korum.test', version: 2, value: null, legal: { version: '2026-11-13', status: 'PUBLICADO' }, status: null, sessionsClosed: null, walletConfirmed: false },
      { id: 3, occurredAt: NOW, action: 'settings.connection_tested', target: 'paycomet', actorEmail: 'yo@korum.test', version: null, value: null, legal: null, status: 'FAILED', sessionsClosed: null, walletConfirmed: false },
      { id: 2, occurredAt: NOW, action: 'superadmin.revoked', target: 'abc123', actorEmail: null, version: null, value: null, legal: null, status: null, sessionsClosed: 2, walletConfirmed: false },
      { id: 1, occurredAt: NOW, action: 'settings.secret.updated', target: 'paycomet.apiKey', actorEmail: 'yo@korum.test', version: null, value: null, legal: null, status: null, sessionsClosed: null, walletConfirmed: false }
    ];
    const { unmount } = renderAll(<HistoryTable history={{ rows, hasMore: true, limit: 25 }} />);
    const table = within(screen.getByTestId('history-table'));
    expect(table.getAllByRole('row')).toHaveLength(6);
    expect(table.getByText('valor: 48 · cambio nº 3')).toBeTruthy();
    expect(table.getByText('versión 2026-11-13 (publicado)')).toBeTruthy();
    expect(table.getByText('rechazada')).toBeTruthy();
    expect(table.getByText('2 sesiones cerradas')).toBeTruthy();
    expect(table.getAllByText('Una persona del equipo')).toHaveLength(1);
    expect(table.getByText('Sistema')).toBeTruthy();
    expect(screen.getByTestId('history-more')).toHaveAttribute('href', '/admin/ajustes');
    // Ninguna fila enseña un secreto: la clave guardada no lleva detalle.
    expect(table.getByText('Clave guardada').closest('tr')!.querySelectorAll('td')[4]!.textContent).toBe('');
    unmount();
    renderAll(<HistoryTable history={{ rows: [], hasMore: false, limit: 25 }} />);
    expect(screen.getByTestId('history-empty').textContent).toBe('Todavía no hay cambios registrados.');
  });
});

describe('Los tres idiomas', () => {
  it.each(['ca', 'en'] as const)('la pantalla se pinta en %s sin una sola clave de traducción sin resolver', async (locale) => {
    const { container } = renderAll(
      <>
        <PaymentsSettings fields={FIELDS} secrets={SECRETS} mode="live" />
        <EmailSettings fields={FIELDS} secrets={SECRETS} />
        <InvoicingSettings fields={FIELDS} secrets={SECRETS} />
        <HuchaSettings fields={FIELDS} secrets={SECRETS} />
        <AutoBoostSettings fields={FIELDS} />
        <SeoSettings fields={FIELDS} secrets={SECRETS} defaultPolicy={crawlers} />
        <CompanySettings field={undefined} />
        <LegalSettings overview={OVERVIEW} selected={PUBLISHED} policyVersion="2026-11-01" suggestedVersion="2026-11-13.1" />
        <LimitsSettings fields={FIELDS} fixedLimits={[{ id: 'authEmail', limit: 5, windowMs: 900_000 }]} />
        <TeamSettings members={MEMBERS} invitations={INVITATIONS} />
        <SecurityPanel security={SECURITY} />
        <HistoryTable history={{ rows: [{ id: 1, occurredAt: NOW, action: 'settings.setting.updated', target: 'hucha.mode', actorEmail: 'yo@korum.test', version: 1, value: 'PLEDGE', legal: null, status: null, sessionsClosed: null, walletConfirmed: false }], hasMore: false, limit: 25 }} />
      </>,
      locale
    );
    expect(container.textContent).not.toMatch(/admin\.settings\./);
    expect(container.querySelectorAll('button').length).toBeGreaterThan(10);
  });
});
