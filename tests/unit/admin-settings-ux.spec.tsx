import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretField } from '@/components/admin/settings/settings-secret-field';
import { CompanySettings, LegalSettings } from '@/components/admin/settings/settings-legal';
import { HistoryTable, SecurityPanel } from '@/components/admin/settings/settings-readonly';
import { EmailSettings, InvoicingSettings, PaymentsSettings } from '@/components/admin/settings/settings-sections';
import { UnsavedProvider } from '@/components/admin/settings/settings-kit';
import { SeoSettings } from '@/components/admin/settings/settings-seo';
import { TeamSettings } from '@/components/admin/settings/settings-team';
import { ToastProvider } from '@/components/ui/toast-provider';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import type { HistoryRow, LegalOverviewRow, LegalSelected, SecurityView, SettingFieldView } from '@/services/admin/platform-settings-view';
import type { SecretSummary } from '@/services/settings/settings.service';
import { renderWithIntl } from '../utils/render-with-intl';

/** Sprint 5.4 · revisión de experiencia en navegador real: errores junto al campo, foco, teclado, formularios, avisos y nombres legibles (QA-A05). */

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

let consoleErrors: { mock: { calls: unknown[][] } };
beforeEach(() => {
  consoleErrors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  actions.saveSectionAction.mockResolvedValue({ status: 'DONE', detail: '1' });
  actions.saveLegalTextAction.mockResolvedValue({ status: 'DONE', detail: '2026-11-13' });
  actions.inviteSuperadminAction.mockResolvedValue({ status: 'DONE' });
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
  'seo.aiCrawlers': field(null, 0, 'none'),
  'seo.verification.google': field(null, 0, 'none'),
  'seo.verification.bing': field(null, 0, 'none')
};
const secret = (key: string, over: Partial<SecretSummary> = {}): SecretSummary => ({ key: key as SecretSummary['key'], configured: false, hint: null, usesEnvFallback: false, updatedAt: null, ...over });
const SECRETS: Record<string, SecretSummary> = {
  'paycomet.apiKey': secret('paycomet.apiKey', { configured: true, hint: 'ZZZZ', updatedAt: new Date('2026-11-12T10:30:00Z') }),
  'paycomet.webhookSecret': secret('paycomet.webhookSecret'),
  'email.apiKey': secret('email.apiKey'),
  'invoicing.apiKey': secret('invoicing.apiKey'),
  'seo.indexNowKey': secret('seo.indexNowKey')
};
const crawlers = { search: [{ userAgent: 'PerplexityBot', allow: true }], training: [{ userAgent: 'GPTBot', allow: true }] };
const NOW = new Date('2026-11-13T10:00:00Z');
const MEMBERS = [
  { id: 'yo', email: 'yo@korum.test', twoFactorEnabled: true, isYou: true, lastSeenAt: NOW },
  { id: 'otra', email: 'otra@korum.test', twoFactorEnabled: false, isYou: false, lastSeenAt: null }
];
const OVERVIEW: LegalOverviewRow[] = (['terminos', 'privacidad', 'cookies', 'aviso-legal'] as const).flatMap((document) =>
  (['es', 'ca', 'en'] as const).map((locale) => ({ document, locale, version: document === 'terminos' && locale === 'es' ? '2026-11-13' : null, status: document === 'terminos' && locale === 'es' ? ('PUBLICADO' as const) : null, characters: 10, settingVersion: 0 }))
);
const PUBLISHED: LegalSelected = { document: 'terminos', locale: 'es', settingVersion: 2, text: { version: '2026-11-13', status: 'PUBLICADO', markdown: 'Texto vigente.' } };
const SECURITY: SecurityView = { keyVersion: 2, previousKeys: 1, pending: { PlatformSecret: 0, Contribution: 3 }, pendingTotal: 3, alerts: { CARD_DELETE_FAILED: 0, PRIVACY_REQUEST_OVERDUE: 0, ENCRYPTION_KEY_MISSING: 0 } };

describe('errores junto al campo y teclado', () => {
  it('un error de un campo sale al lado del campo y lo enlaza con aria-describedby; los demás campos no se marcan', async () => {
    const user = userEvent.setup();
    actions.saveSectionAction.mockResolvedValue({ status: 'REJECTED', reason: 'INVALID', fields: ['paycomet.terminalId'] });
    renderAll(<PaymentsSettings fields={FIELDS} secrets={SECRETS} mode="mock" />);
    await user.click(screen.getByTestId('save-pagos'));
    const terminal = screen.getByLabelText('Terminal');
    const error = await screen.findByText('Este valor no es válido: revisa su formato.');
    expect(terminal.getAttribute('aria-describedby')).toContain(error.id);
    expect(terminal).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Código de comercio')).not.toHaveAttribute('aria-invalid');
  });

  it('Intro en un campo guarda el bloque (cada bloque es un formulario) y mientras guarda el botón no se deshabilita (conserva el foco) ni repite la llamada', async () => {
    const user = userEvent.setup();
    let resolve: (value: unknown) => void = () => undefined;
    actions.saveSectionAction.mockReturnValue(new Promise((done) => (resolve = done)));
    renderAll(<PaymentsSettings fields={FIELDS} secrets={SECRETS} mode="mock" />);
    await user.click(screen.getByLabelText('JET ID'));
    await user.keyboard('abc{Enter}');
    await waitFor(() => expect(actions.saveSectionAction).toHaveBeenCalledTimes(1));
    const button = screen.getByTestId('save-pagos');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    await user.click(button);
    expect(actions.saveSectionAction).toHaveBeenCalledTimes(1);
    resolve({ status: 'DONE', detail: '1' });
    await waitFor(() => expect(screen.getByTestId('save-pagos')).toHaveAttribute('aria-disabled', 'false'));
  });

  it('los datos de la empresa marcan solo el campo que falla, con su mensaje y el foco en él, y lo nombran en lenguaje llano', async () => {
    const user = userEvent.setup();
    actions.saveSectionAction.mockResolvedValue({ status: 'REJECTED', reason: 'INVALID', fields: ['platform.company.taxId'] });
    renderAll(<CompanySettings field={field({ legalName: 'KORUM S.L.', taxId: 'B12345679', address: 'Calle Mayor 1', supportEmail: 'a@korum.test', privacyEmail: 'b@korum.test' }, 1)} />);
    await user.click(screen.getByTestId('save-empresa'));
    const nif = screen.getByLabelText('NIF o CIF');
    await waitFor(() => expect(nif).toHaveFocus());
    expect(nif).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('El NIF o CIF no es válido: revisa la última cifra o letra.').id).toBe(nif.getAttribute('aria-describedby'));
    expect(screen.getByLabelText('Razón social')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Domicilio')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByTestId('settings-outcome').textContent).toContain('Revisa: NIF o CIF.');
  });

  it('un error al publicar un texto cierra la confirmación, nombra el campo («Versión») y lleva el foco a él con su mensaje', async () => {
    const user = userEvent.setup();
    actions.saveLegalTextAction.mockResolvedValue({ status: 'REJECTED', reason: 'VERSION_OLDER', fields: ['version'] });
    renderAll(<LegalSettings overview={OVERVIEW} selected={PUBLISHED} policyVersion="2026-11-01" suggestedVersion="2026-11-13.1" />);
    await user.type(screen.getByTestId('legal-markdown'), ' Más.');
    await user.click(screen.getByTestId('legal-save'));
    await user.click(screen.getByTestId('legal-confirm'));
    await waitFor(() => expect(screen.getByTestId('legal-version')).toHaveFocus());
    expect(screen.queryByRole('group', { name: /Vas a publicar/ })).toBeNull();
    expect(screen.getByTestId('settings-outcome').textContent).toContain('Revisa: Versión.');
    expect(screen.getAllByText('La versión no puede ser anterior a la guardada.').length).toBeGreaterThan(0);
  });

  it('Escape cancela las confirmaciones (quitar clave, retirar acceso, publicar) y el foco empieza en «Cancelar»', async () => {
    const user = userEvent.setup();
    const secretView = renderAll(<SecretField secretKey="paycomet.apiKey" summary={SECRETS['paycomet.apiKey']} />);
    await user.click(screen.getByTestId('secret-remove-paycomet.apiKey'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: /Quitar/ })).toBeNull();
    await waitFor(() => expect(screen.getByTestId('secret-remove-paycomet.apiKey')).toHaveFocus());
    secretView.unmount();

    const teamView = renderAll(<TeamSettings members={MEMBERS} invitations={[]} />);
    await user.click(within(screen.getAllByTestId('team-member')[1]!).getByTestId('team-revoke'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('team-revoke-yes')).toBeNull();
    teamView.unmount();

    renderAll(<LegalSettings overview={OVERVIEW} selected={PUBLISHED} policyVersion="2026-11-01" suggestedVersion="2026-11-13.1" />);
    await user.type(screen.getByTestId('legal-markdown'), ' Más.');
    await user.click(screen.getByTestId('legal-save'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('legal-confirm')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('legal-save')).toHaveFocus());
  });

  it('quitar un rastreador lo dice y lleva el foco al campo de alta de su lista; la lista inicial se recupera con un botón y avisa de lo que falta por guardar', async () => {
    const user = userEvent.setup();
    renderAll(<SeoSettings fields={FIELDS} secrets={SECRETS} defaultPolicy={crawlers} />);
    const reset = screen.getByTestId('crawlers-reset');
    expect(reset).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByTestId('crawlers-dirty')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Quitar a PerplexityBot de la lista' }));
    const group = within(screen.getByTestId('crawlers-search'));
    expect(group.getByLabelText('Añadir un rastreador (nombre del agente)')).toHaveFocus();
    expect(group.getByRole('status').textContent).toBe('PerplexityBot quitado de la lista (falta guardar).');
    expect(screen.getByTestId('crawlers-dirty').textContent).toBe('Hay cambios en la lista sin guardar.');
    await user.click(reset);
    // Los grupos se recrean: vuelve la lista inicial y desaparece el aviso del estado anterior.
    const restored = within(screen.getByTestId('crawlers-search'));
    expect(restored.getByRole('checkbox', { name: /PerplexityBot/ })).toBeTruthy();
    expect(restored.getByRole('status').textContent).toBe('');
    expect(screen.queryByTestId('crawlers-dirty')).toBeNull();
    // Sin cambios, el botón de la lista inicial no parece estar cargando.
    expect(screen.getByTestId('crawlers-reset').className).not.toContain('aria-disabled:cursor-wait');
    expect(screen.getByRole('heading', { level: 3, name: 'Búsqueda y respuesta' })).toBeTruthy();
  });

  it('un proveedor de email guardado que ya no se ofrece (SMTP) arranca en Brevo y se guarda corrigiéndolo', async () => {
    const user = userEvent.setup();
    renderAll(<EmailSettings fields={{ ...FIELDS, 'email.provider': field('smtp', 4) }} secrets={SECRETS} />);
    expect((screen.getByLabelText('Proveedor de email') as HTMLSelectElement).value).toBe('brevo');
    await user.click(screen.getByTestId('save-email'));
    await waitFor(() => expect(actions.saveSectionAction).toHaveBeenCalledWith(expect.objectContaining({ values: expect.objectContaining({ 'email.provider': 'brevo' }), versions: expect.objectContaining({ 'email.provider': 4 }) })));
  });

  it('una alerta de clave perdida pesa más que una rotación en marcha en el estado de las claves', () => {
    renderAll(<SecurityPanel security={{ ...SECURITY, alerts: { ...SECURITY.alerts, ENCRYPTION_KEY_MISSING: 2 } }} />);
    expect(screen.getByTestId('rotation-state').textContent).toMatch(/no está entre las configuradas/);
  });

  it('el idioma del email de la invitación se elige (por defecto el de la pantalla) y un correo rechazado se dice con texto, marca el campo y le devuelve el foco', async () => {
    const user = userEvent.setup();
    actions.inviteSuperadminAction.mockResolvedValue({ status: 'REJECTED', reason: 'INVALID_EMAIL', fields: [] });
    renderAll(<TeamSettings members={MEMBERS} invitations={[]} />, 'ca');
    expect((screen.getByTestId('team-invite-language') as HTMLSelectElement).value).toBe('ca');
    await user.selectOptions(screen.getByTestId('team-invite-language'), 'en');
    await user.type(screen.getByTestId('team-invite-email'), 'esto-no-es-un-correo');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(actions.inviteSuperadminAction).toHaveBeenCalledWith({ email: 'esto-no-es-un-correo', locale: 'en' }));
    const input = screen.getByTestId('team-invite-email');
    await waitFor(() => expect(input).toHaveAttribute('aria-invalid', 'true'));
    expect(input.getAttribute('aria-describedby')).toContain(screen.getByTestId('settings-outcome').id);
    expect(input).toHaveFocus();
  });

  it('«Probar conexión» distingue con su icono lo informativo del error y deja el foco en el botón', async () => {
    const user = userEvent.setup();
    actions.testConnectionAction.mockResolvedValue({ status: 'RESULT', result: { status: 'SIMULATED' } });
    renderAll(<InvoicingSettings fields={FIELDS} secrets={SECRETS} />);
    await user.click(screen.getByTestId('test-invoicing-button'));
    await waitFor(() => expect(screen.getByTestId('test-invoicing-result').textContent).toMatch(/^ℹ /));
    actions.testConnectionAction.mockResolvedValue({ status: 'RESULT', result: { status: 'FAILED', code: 'CONFIG' } });
    await user.click(screen.getByTestId('test-invoicing-button'));
    await waitFor(() => expect(screen.getByTestId('test-invoicing-result').textContent).toMatch(/^✖ Hay un ajuste o una clave guardados que no se pueden leer/));
    expect(screen.getByTestId('test-invoicing-button')).toHaveFocus();
  });

  it('el historial pone nombre legible a lo que cambió (ajuste, clave, texto legal, conexión) y nunca solo su clave técnica', () => {
    const base = { occurredAt: NOW, actorEmail: 'yo@korum.test', version: 2, value: null, legal: null, status: null, sessionsClosed: null, walletConfirmed: false };
    const rows: HistoryRow[] = [
      { ...base, id: 4, action: 'settings.setting.updated', target: 'platform.company' },
      { ...base, id: 3, action: 'settings.setting.updated', target: 'legal.cookies.en', legal: { version: '2026-11-13', status: 'PUBLICADO' } },
      { ...base, id: 2, action: 'settings.secret.updated', target: 'seo.indexNowKey' },
      { ...base, id: 1, action: 'settings.connection_tested', target: 'paycomet', status: 'OK' }
    ];
    renderAll(<HistoryTable history={{ rows, hasMore: false, limit: 25 }} />);
    const table = within(screen.getByTestId('history-table'));
    expect(table.getByText('Datos de la empresa')).toBeTruthy();
    expect(table.getByText('Política de cookies · Inglés')).toBeTruthy();
    expect(table.getByText('Clave de IndexNow')).toBeTruthy();
    expect(table.getByText('Conexión con Paycomet')).toBeTruthy();
    expect(table.queryByText('platform.company')).toBeNull();
    expect(table.queryByText('legal.cookies.en')).toBeNull();
  });
});

describe('segunda revisión de experiencia · foco tras el éxito, conflictos, cambios sin guardar y campos vacíos', () => {
  it('un campo obligatorio vacío dice «Escribe…» y uno escrito mal dice qué revisar', async () => {
    const user = userEvent.setup();
    actions.saveSectionAction.mockResolvedValue({ status: 'REJECTED', reason: 'INVALID', fields: ['platform.company.taxId', 'platform.company.supportEmail'] });
    renderAll(<CompanySettings field={field({ legalName: 'KORUM S.L.', taxId: '', address: 'Calle Mayor 1', supportEmail: 'no-es-email', privacyEmail: 'b@korum.test' }, 1)} />);
    await user.click(screen.getByTestId('save-empresa'));
    expect(await screen.findByText('Escribe el NIF o CIF.')).toBeTruthy();
    expect(screen.getByText('El email de soporte no es válido.')).toBeTruthy();
    expect(screen.queryByText('El NIF o CIF no es válido: revisa la última cifra o letra.')).toBeNull();
  });

  it('tras guardar o publicar un texto con éxito el foco pasa al título del editor (existe tras volver a montarlo), no al <body>', async () => {
    const user = userEvent.setup();
    renderAll(<LegalSettings overview={OVERVIEW} selected={{ document: 'cookies', locale: 'es', settingVersion: 0, text: null }} policyVersion="2026-11-01" suggestedVersion="2026-11-13" />);
    await user.type(screen.getByTestId('legal-markdown'), 'Texto');
    await user.click(screen.getByTestId('legal-save'));
    await waitFor(() => expect(actions.saveLegalTextAction).toHaveBeenCalled());
    await waitFor(() => expect(document.activeElement?.id).toBe('editor-texto'));
    // Sin haber publicado nunca, el botón dice «Publicar este texto».
    await user.click(screen.getByRole('radio', { name: 'Publicado' }));
    expect(screen.getByTestId('legal-save').textContent).toBe('Publicar este texto');
  });

  it('un conflicto de versión de un texto legal nombra el texto en lenguaje llano y lleva el foco al aviso (el campo no existe)', async () => {
    const user = userEvent.setup();
    actions.saveLegalTextAction.mockResolvedValue({ status: 'REJECTED', reason: 'STALE', fields: ['legal.terminos.es'] });
    renderAll(<LegalSettings overview={OVERVIEW} selected={PUBLISHED} policyVersion="2026-11-01" suggestedVersion="2026-11-13.1" />);
    await user.type(screen.getByTestId('legal-markdown'), ' Más.');
    await user.click(screen.getByTestId('legal-save'));
    await user.click(screen.getByTestId('legal-confirm'));
    const alert = await screen.findByTestId('settings-outcome');
    expect(alert.textContent).toContain('Revisa: Términos y condiciones · Castellano.');
    expect(alert.textContent).not.toContain('legal.terminos.es');
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('retirar el acceso con éxito pasa el foco al campo de invitar; anular una invitación pide confirmar con el foco en «Cancelar» y Escape la cierra', async () => {
    const user = userEvent.setup();
    renderAll(<TeamSettings members={MEMBERS} invitations={[{ userId: 'nueva', email: 'nueva@korum.test', expiresAt: new Date('2026-11-16T10:00:00Z'), expired: false }]} />);
    await user.click(within(screen.getAllByTestId('team-member')[1]!).getByTestId('team-revoke'));
    await user.click(screen.getByTestId('team-revoke-yes'));
    await waitFor(() => expect(actions.revokeSuperadminAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('team-invite-email')).toHaveFocus());

    await user.click(screen.getByRole('button', { name: 'Anular invitación de nueva@korum.test' }));
    const invitation = within(screen.getByTestId('team-invitation'));
    await waitFor(() => expect(invitation.getByRole('button', { name: 'Cancelar' })).toHaveFocus());
    expect(actions.cancelSuperadminInvitationAction).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('team-cancel-invitation-yes')).toBeNull();
    // El formulario de invitar pone la etiqueta del email pegada a su campo y el idioma después.
    const emailLabel = screen.getByText('Email de la persona');
    expect(emailLabel.getAttribute('for')).toBe(screen.getByTestId('team-invite-email').id);
  });

  it('con cambios sin guardar, elegir otro texto legal pregunta antes; sin cambios, no pregunta', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderAll(
      <UnsavedProvider>
        <LegalSettings overview={OVERVIEW} selected={{ document: 'cookies', locale: 'es', settingVersion: 0, text: null }} policyVersion="2026-11-01" suggestedVersion="2026-11-13" />
      </UnsavedProvider>
    );
    // Sin cambios no pregunta (la navegación del enlace en las pruebas no se completa, solo se comprueba la pregunta).
    await user.click(screen.getByTestId('legal-terminos-ca'));
    expect(confirm).not.toHaveBeenCalled();
    await user.type(screen.getByTestId('legal-markdown'), 'Texto sin guardar');
    await user.click(screen.getByTestId('legal-terminos-ca'));
    expect(confirm).toHaveBeenCalledWith('Hay cambios sin guardar. Si sales ahora se perderán. ¿Salir igualmente?');
    confirm.mockRestore();
  });

  it('el aviso de cambios sin guardar cubre cualquier enlace que salga de la pantalla (cabecera, «Ver más cambios», avisos de precios), pero no un ancla de la misma página', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderAll(
      <UnsavedProvider>
        <Link href="/admin#salud-de-precios">Avisos de precios</Link>
        <Link href={`${window.location.pathname}#historial`}>Ancla de esta página</Link>
        <Link href="/?historial=50">Ver más cambios</Link>
        <PaymentsSettings fields={FIELDS} secrets={SECRETS} mode="mock" />
      </UnsavedProvider>
    );
    await user.click(screen.getByText('Avisos de precios'));
    expect(confirm).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('JET ID'), 'abc');
    await user.click(screen.getByText('Avisos de precios'));
    await user.click(screen.getByText('Ver más cambios'));
    expect(confirm).toHaveBeenCalledTimes(2);
    await user.click(screen.getByText('Ancla de esta página'));
    expect(confirm).toHaveBeenCalledTimes(2);
    // Guardar con éxito deja el bloque sin cambios pendientes: ya no pregunta.
    await user.click(screen.getByTestId('save-pagos'));
    await waitFor(() => expect(actions.saveSectionAction).toHaveBeenCalled());
    await waitFor(() => {
      confirm.mockClear();
    });
    await user.click(screen.getByText('Avisos de precios'));
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('el aviso del navegador (beforeunload) salta con cambios sin guardar, pero no vuelve a preguntar justo después de aceptar salir (cerrar sesión recarga la página entera)', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderAll(
      <UnsavedProvider>
        <button type="button" data-confirm-leave="true">
          Cerrar sesión
        </button>
        <PaymentsSettings fields={FIELDS} secrets={SECRETS} mode="mock" />
      </UnsavedProvider>
    );
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(false);
    await user.type(screen.getByLabelText('JET ID'), 'abc');
    expect(unload()).toBe(true);
    await user.click(screen.getByText('Cerrar sesión'));
    expect(confirm).toHaveBeenCalledTimes(1);
    // Aceptó salir: la recarga completa no pregunta otra vez.
    expect(unload()).toBe(false);
    confirm.mockRestore();
  });

  it('un botón marcado como «sale de la pantalla» (cerrar sesión) pregunta antes de hacer nada cuando hay cambios sin guardar', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const exit = vi.fn();
    renderAll(
      <UnsavedProvider>
        <button type="button" data-confirm-leave="true" onClick={exit}>
          Cerrar sesión
        </button>
        <PaymentsSettings fields={FIELDS} secrets={SECRETS} mode="mock" />
      </UnsavedProvider>
    );
    await user.click(screen.getByText('Cerrar sesión'));
    expect(confirm).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    await user.type(screen.getByLabelText('JET ID'), 'abc');
    // Con cambios y la respuesta «quedarse», el botón ni siquiera llega a ejecutar su acción (la sesión no se cierra).
    await user.click(screen.getByText('Cerrar sesión'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(true);
    await user.click(screen.getByText('Cerrar sesión'));
    expect(exit).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it('un cambio de OTRA persona (los datos guardados cambian al recargar) no convierte la pantalla en «con cambios sin guardar»', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    function Harness() {
      const [saved, setSaved] = useState<unknown>(null);
      return (
        <UnsavedProvider>
          <button type="button" onClick={() => setSaved({ legalName: 'Otra persona S.L.', taxId: 'B12345674', address: 'Calle Nueva 2', supportEmail: 'x@korum.test', privacyEmail: 'y@korum.test' })}>
            Simular el guardado de otra persona
          </button>
          <Link href="/admin">Volver</Link>
          <CompanySettings field={field(saved, saved ? 5 : 0)} />
          <SeoSettings fields={{ ...FIELDS, 'seo.aiCrawlers': field(saved ? { search: [], training: [] } : null, saved ? 3 : 0) }} secrets={SECRETS} defaultPolicy={crawlers} />
        </UnsavedProvider>
      );
    }
    renderAll(<Harness />);
    await user.click(screen.getByText('Simular el guardado de otra persona'));
    await user.click(screen.getByText('Volver'));
    expect(confirm).not.toHaveBeenCalled();
    // Lo que escribe esta persona sí cuenta.
    await user.type(screen.getByLabelText('Domicilio'), ' bis');
    await user.click(screen.getByText('Volver'));
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it('tras invitar con éxito el foco vuelve al campo del email', async () => {
    const user = userEvent.setup();
    renderAll(<TeamSettings members={MEMBERS} invitations={[]} />);
    await user.type(screen.getByTestId('team-invite-email'), 'nueva@korum.test');
    await user.click(screen.getByTestId('team-invite-send'));
    await waitFor(() => expect(actions.inviteSuperadminAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('team-invite-email')).toHaveFocus());
  });
});
