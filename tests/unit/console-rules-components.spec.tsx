import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockedMoneyAlert } from '@/components/admin/blocked-money-alert';
import { GlobalCategories } from '@/components/admin/global-categories';
import { GlobalRulesForm } from '@/components/admin/global-rules-form';
import { MedalsForm } from '@/components/admin/medals-form';
import { OrgDirectEmail } from '@/components/admin/org-direct-email';
import { PricingHealthPanel, type PricingAlertItem } from '@/components/admin/pricing-health-panel';
import { SplitsToResolve } from '@/components/admin/splits-to-resolve';
import { SupportTicketCard } from '@/components/admin/support-ticket-card';
import { ToastProvider } from '@/components/ui/toast-provider';
import type { GlobalRulesInput } from '@/core/admin/global-rules';
import { evaluatePricingHealth, reviewPricingAlerts } from '@/core/finance/pricing-health';
import { pricingRulesOf } from '@/core/admin/global-rules';
import { LOCALES, type Locale } from '@/i18n/routing';
import { rulesVersionOf } from '@/services/admin/global-rules.service';
import type { ConsoleTicket } from '@/services/admin/console-support.service';
import { renderWithIntl } from '../utils/render-with-intl';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, prefetch: _prefetch, ...props }: { href: string | { pathname: string }; children: ReactNode; prefetch?: boolean }) => (
    <a href={typeof href === 'string' ? href : href.pathname} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({ refresh: vi.fn() })
}));
const rulesActions = { saveRulesAction: vi.fn(), saveMedalsAction: vi.fn(), addGlobalCategoryAction: vi.fn(), setGlobalCategoryRuleAction: vi.fn(), acknowledgePricingAlertAction: vi.fn() };
vi.mock('@/app/[locale]/(superadmin)/admin/reglas/actions', () => ({
  saveRulesAction: (...args: unknown[]) => rulesActions.saveRulesAction(...args),
  saveMedalsAction: (...args: unknown[]) => rulesActions.saveMedalsAction(...args),
  addGlobalCategoryAction: (...args: unknown[]) => rulesActions.addGlobalCategoryAction(...args),
  setGlobalCategoryRuleAction: (...args: unknown[]) => rulesActions.setGlobalCategoryRuleAction(...args),
  acknowledgePricingAlertAction: (...args: unknown[]) => rulesActions.acknowledgePricingAlertAction(...args)
}));
const supportActions = { answerPlatformTicketAction: vi.fn(), closeRectificationAction: vi.fn(), rectifyNameAction: vi.fn(), sendDirectEmailAction: vi.fn() };
vi.mock('@/app/[locale]/(superadmin)/admin/soporte/actions', () => ({
  answerPlatformTicketAction: (...args: unknown[]) => supportActions.answerPlatformTicketAction(...args),
  closeRectificationAction: (...args: unknown[]) => supportActions.closeRectificationAction(...args),
  rectifyNameAction: (...args: unknown[]) => supportActions.rectifyNameAction(...args),
  sendDirectEmailAction: (...args: unknown[]) => supportActions.sendDirectEmailAction(...args)
}));
const consoleActions = { resolveAlertWithNoteAction: vi.fn(), resolveSplitAction: vi.fn() };
vi.mock('@/app/[locale]/(superadmin)/admin/actions', () => ({
  resolveAlertWithNoteAction: (...args: unknown[]) => consoleActions.resolveAlertWithNoteAction(...args),
  resolveSplitAction: (...args: unknown[]) => consoleActions.resolveSplitAction(...args)
}));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

/** Una clave de traducción sin resolver no rompe el render (next-intl pinta la clave y avisa por consola): se vigila aquí, porque la E2E lo detecta tarde. */
let consoleErrors: { mock: { calls: unknown[][] } };
beforeEach(() => {
  consoleErrors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  const missing = consoleErrors.mock.calls.map((call: unknown[]) => String(call[0])).filter((message: string) => message.includes('MISSING_MESSAGE'));
  expect(missing).toEqual([]);
  vi.clearAllMocks();
});

const renderAll = (node: ReactNode, locale: Locale = 'es') => renderWithIntl(<ToastProvider>{node}</ToastProvider>, locale);

const RULES: GlobalRulesInput = {
  exemptLimitCents: 100_000,
  bracketMode: 'FLAT',
  t1MaxCents: 500_000,
  t2MaxCents: 1_500_000,
  t1Bps: 500,
  t2Bps: 400,
  t3Bps: 300,
  sponsorFeeBps: 1_500,
  fullIntegrityCheckCents: 180,
  guaranteePresetsCents: [0, 100, 200, 400],
  defaultGuaranteeIdx: 2,
  gatewayPctBps: 100,
  gatewayFixedCents: 9,
  topupFeeCents: 25,
  topupFeeBps: 0,
  ticketFeeFixedCents: 45,
  ticketFeeBps: 200,
  maintActive: false,
  maintPerInitCents: 4_900,
  maintAnnualCapCents: 14_700,
  maxCampaignDays: 60,
  creditPoolMaxDays: 60
};
const UPDATED_AT = '2026-11-12T10:00:00.000Z';
const VERSION = rulesVersionOf(RULES);
const form = (overrides: Partial<Parameters<typeof GlobalRulesForm>[0]> = {}) => <GlobalRulesForm rules={RULES} version={VERSION} margins={{}} acknowledgements={[]} {...overrides} />;

describe('QA-A04 · motor de reglas: formulario con salud de precios en vivo', () => {
  it('abre con los valores por defecto, sus avisos junto a los campos y el validador de entradas en positivo', () => {
    renderAll(form());
    expect((screen.getByLabelText(/Comisión del tramo 1/) as HTMLInputElement).value).toBe('5');
    expect((screen.getByLabelText(/Fijo por transacción/) as HTMLInputElement).value).toBe('0,09');
    expect((screen.getByLabelText(/Duración máxima de una campaña/) as HTMLInputElement).value).toBe('60');
    // Con los valores por defecto saltan la Hucha y el escalón, cada uno en su bloque, con su cifra.
    expect(within(screen.getByTestId('block-pasarela')).getByText(/Un cargo de 50,00 € en Mi Hucha cuesta 0,59 € de pasarela y cobras 0,25 €/)).toBeInTheDocument();
    expect(within(screen.getByTestId('block-tramos')).getByText(/un presupuesto de 5.000,00 € paga 200,00 € de comisión/)).toBeInTheDocument();
    expect(screen.getByTestId('ticket-margin-ok')).toHaveTextContent('+0,40 € por entrada');
  });

  it('el aviso se recalcula mientras se escribe y desaparece cuando el valor deja de perder dinero', async () => {
    renderAll(form());
    const hucha = screen.getByLabelText(/Comisión de Mi Hucha: fijo por cargo/);
    expect(screen.getByTestId('block-pasarela').querySelector('[data-pricing-alert="HUCHA_FEE_BELOW_GATEWAY_COST"]')).not.toBeNull();
    await userEvent.clear(hucha);
    await userEvent.type(hucha, '2');
    expect(screen.getByTestId('block-pasarela').querySelector('[data-pricing-alert="HUCHA_FEE_BELOW_GATEWAY_COST"]')).toBeNull();
    // Y los gastos de entrada que no cubren la pasarela avisan con la cifra, sin el «✔️» del margen positivo.
    const fixed = screen.getByLabelText(/Gastos de gestión digital: fijo por entrada/);
    await userEvent.clear(fixed);
    await userEvent.type(fixed, '0');
    const percent = screen.getByLabelText(/Gastos de gestión digital: % sobre el precio/);
    await userEvent.clear(percent);
    await userEvent.type(percent, '0');
    expect(screen.queryByTestId('ticket-margin-ok')).toBeNull();
    expect(screen.getByTestId('block-pasarela').querySelector('[data-pricing-alert="TICKET_FEE_BELOW_GATEWAY_COST"]')).not.toBeNull();
  });

  it('un aviso que sale de valores sin guardar no se puede aceptar y dice que hay que guardar primero', async () => {
    renderAll(form());
    const hucha = screen.getByLabelText(/Comisión de Mi Hucha: fijo por cargo/);
    await userEvent.clear(hucha);
    await userEvent.type(hucha, '0,10');
    const alert = screen.getByTestId('block-pasarela').querySelector('[data-pricing-alert="HUCHA_FEE_BELOW_GATEWAY_COST"]') as HTMLElement;
    expect(within(alert).getByTestId('pricing-accept')).toBeDisabled();
    expect(alert).toHaveTextContent(/Guarda primero las reglas/);
  });

  it('«Ajustar» lleva el foco al campo implicado', async () => {
    renderAll(form());
    const alert = screen.getByTestId('block-pasarela').querySelector('[data-pricing-alert="HUCHA_FEE_BELOW_GATEWAY_COST"]') as HTMLElement;
    await userEvent.click(within(alert).getByTestId('pricing-adjust'));
    await waitFor(() => expect(screen.getByLabelText(/Comisión de Mi Hucha: fijo por cargo/)).toHaveFocus(), { timeout: 4000 });
  });

  it('un valor imposible se marca en el campo con su texto, el foco va al primero y no se llama al servidor', async () => {
    renderAll(form());
    const percent = screen.getByLabelText(/Comisión del tramo 1/);
    await userEvent.clear(percent);
    await userEvent.type(percent, '4,567');
    const days = screen.getByLabelText(/Duración máxima de una campaña/);
    await userEvent.clear(days);
    await userEvent.type(days, '76');
    await userEvent.click(screen.getByTestId('rules-save'));
    expect(rulesActions.saveRulesAction).not.toHaveBeenCalled();
    expect(percent).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(percent).toHaveFocus(), { timeout: 4000 });
    expect(screen.getByText('Hay 2 campos con un valor no válido: corrígelos para guardar.')).toBeInTheDocument();
    expect(screen.getAllByText(/Escribe un/)).toHaveLength(2);
    // El texto dice el límite en cifras, no «dentro del límite».
    expect(screen.getByText('Escribe un número entero de días, de 1 a 75.')).toBeInTheDocument();
    expect(screen.getByText(/Escribe un valor de 0,00 € a 100,00 %|Escribe un valor de 0 % a 100 %|Escribe un valor de 0,00 % a 100,00 %|Escribe un valor de 0 a 100 %/)).toBeInTheDocument();
  });

  it('un campo que el servidor rechaza (taquilla a la venta) se marca y recibe el foco, con el mensaje de que no se ha guardado nada', async () => {
    rulesActions.saveRulesAction.mockResolvedValue({ status: 'REJECTED', reason: 'TICKETING_ON_SALE', fields: ['ticketFeeFixedCents', 'ticketFeeBps'] });
    renderAll(form());
    await userEvent.click(screen.getByTestId('rules-save'));
    expect(await screen.findByText(/No se ha guardado nada\. Hay una taquilla o rifa a la venta/)).toBeInTheDocument();
    const fixed = screen.getByLabelText(/Gastos de gestión digital: fijo por entrada/);
    expect(fixed).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/Gastos de gestión digital: % sobre el precio/)).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(fixed).toHaveFocus(), { timeout: 4000 });
    expect(screen.getAllByText('Este valor no se puede guardar ahora. Déjalo como estaba y guarda de nuevo.')).toHaveLength(2);
  });

  it('un fallo de red a mitad de guardado no promete que se pueda repetir: pide comprobar antes, con un botón para recargar', async () => {
    rulesActions.saveRulesAction.mockRejectedValue(new Error('red'));
    renderAll(form());
    await userEvent.click(screen.getByTestId('rules-save'));
    expect(await screen.findByText(/No sabemos si se ha guardado/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recargar la página' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('rules-save')).toHaveFocus(), { timeout: 4000 });
  });

  it('guarda con la versión que se veía y dice a cuántas entidades se ha aplicado', async () => {
    rulesActions.saveRulesAction.mockResolvedValue({ status: 'DONE', detail: '1:3' });
    renderAll(form());
    const percent = screen.getByLabelText(/Comisión del tramo 1/);
    await userEvent.clear(percent);
    await userEvent.type(percent, '6');
    await userEvent.click(screen.getByTestId('rules-save'));
    await waitFor(() => expect(rulesActions.saveRulesAction).toHaveBeenCalledTimes(1));
    const payload = rulesActions.saveRulesAction.mock.calls[0]![0] as { rules: GlobalRulesInput; expectedVersion: string };
    expect(payload.expectedVersion).toBe(VERSION);
    expect(payload.rules).toEqual({ ...RULES, t1Bps: 600 });
    expect(await screen.findByText(/Aplicadas a 3 entidades sin tarifa propia/)).toBeInTheDocument();
  });

  it('si otra persona guardó antes lo dice y ofrece recargar; si caducó el segundo factor, enlaza a verificarlo', async () => {
    rulesActions.saveRulesAction.mockResolvedValueOnce({ status: 'REJECTED', reason: 'STALE', fields: [] }).mockResolvedValueOnce({ status: 'REAUTH_REQUIRED' });
    renderAll(form());
    await userEvent.click(screen.getByTestId('rules-save'));
    expect(await screen.findByText(/Otra persona ha guardado cambios mientras editabas/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recargar la página' })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('rules-save'));
    expect(await screen.findByRole('link', { name: 'Volver a verificar mi identidad' })).toBeInTheDocument();
  });

  it('el rechazo por una taquilla a la venta se explica sin culpar al formulario', async () => {
    rulesActions.saveRulesAction.mockResolvedValue({ status: 'REJECTED', reason: 'TICKETING_ON_SALE', fields: ['ticketFeeFixedCents', 'ticketFeeBps'] });
    renderAll(form());
    await userEvent.click(screen.getByTestId('rules-save'));
    expect(await screen.findByText(/Hay una taquilla o rifa a la venta/)).toBeInTheDocument();
  });

  it('los niveles de la aportación voluntaria enseñan su importe en el selector', () => {
    renderAll(form());
    const select = screen.getByLabelText('Nivel que aparece elegido');
    expect(within(select).getByRole('option', { name: 'Nivel 3 (2 €)' })).toBeInTheDocument();
  });

  it.each(LOCALES)('los avisos y los campos salen en %s sin claves sin resolver', (locale) => {
    renderAll(form(), locale);
    expect(screen.getByTestId('rules-form')).toBeInTheDocument();
    expect(screen.getAllByTestId('pricing-health').length).toBeGreaterThan(0);
  });
});

describe('QA-A04 · avisos de precios: «Ajustar» y «Aceptar y registrar»', () => {
  const alerts = (): PricingAlertItem[] => reviewPricingAlerts(evaluatePricingHealth(pricingRulesOf(RULES)), []);

  it('aceptar pide una nota obligatoria y envía el aviso tal y como se vio (código y huella)', async () => {
    rulesActions.acknowledgePricingAlertAction.mockResolvedValue({ status: 'DONE' });
    renderAll(<PricingHealthPanel alerts={alerts()} />);
    const alert = document.querySelector('[data-pricing-alert="HUCHA_FEE_BELOW_GATEWAY_COST"]') as HTMLElement;
    await userEvent.click(within(alert).getByTestId('pricing-accept'));
    expect(within(alert).getByText(/Esto no cambia ninguna regla: KORUM seguirá perdiendo dinero/)).toBeInTheDocument();
    const note = within(alert).getByTestId('pricing-note');
    await waitFor(() => expect(note).toHaveFocus(), { timeout: 4000 });
    // Nota corta: no se envía y se explica en el campo.
    await userEvent.type(note, 'corta');
    await userEvent.click(within(alert).getByTestId('pricing-accept-submit'));
    expect(rulesActions.acknowledgePricingAlertAction).not.toHaveBeenCalled();
    expect(within(alert).getByRole('alert')).toHaveTextContent(/al menos 10 caracteres/);

    await userEvent.clear(note);
    await userEvent.type(note, 'La Hucha es un coste de captación asumido.');
    await userEvent.click(within(alert).getByTestId('pricing-accept-submit'));
    await waitFor(() => expect(rulesActions.acknowledgePricingAlertAction).toHaveBeenCalledTimes(1));
    const hucha = alerts().find((candidate) => candidate.code === 'HUCHA_FEE_BELOW_GATEWAY_COST')!;
    expect(rulesActions.acknowledgePricingAlertAction).toHaveBeenCalledWith({ target: { code: hucha.code, fingerprint: hucha.fingerprint }, note: 'La Hucha es un coste de captación asumido.' });
  });

  it('cancelar devuelve el foco al botón; un aviso aceptado se ve atenuado con su nota y sin botones', async () => {
    renderAll(<PricingHealthPanel alerts={alerts()} />);
    const alert = document.querySelector('[data-pricing-alert="BRACKET_CLIFF"]') as HTMLElement;
    await userEvent.click(within(alert).getByTestId('pricing-accept'));
    await userEvent.click(within(alert).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(within(alert).getByTestId('pricing-accept')).toHaveFocus(), { timeout: 4000 });
  });

  it('un aviso aceptado se muestra atenuado con la nota, sin «Ajustar» ni «Aceptar»', () => {
    const accepted = reviewPricingAlerts(evaluatePricingHealth(pricingRulesOf(RULES)), [
      { code: 'BRACKET_CLIFF', fingerprint: evaluatePricingHealth(pricingRulesOf(RULES)).find((alert) => alert.code === 'BRACKET_CLIFF')!.fingerprint, acknowledgedById: 'u1', acknowledgedAt: '2026-11-10T09:00:00.000Z', note: 'Lo asumimos de momento.' }
    ]);
    renderAll(<PricingHealthPanel alerts={accepted} />);
    const alert = document.querySelector('[data-pricing-alert="BRACKET_CLIFF"]') as HTMLElement;
    expect(alert).toHaveAttribute('data-accepted', 'true');
    expect(alert).toHaveTextContent('Lo asumimos de momento.');
    expect(within(alert).queryByTestId('pricing-accept')).toBeNull();
    expect(within(alert).queryByTestId('pricing-adjust')).toBeNull();
  });

  it('«Ajustar» de la portada es un enlace al campo en el motor de reglas', () => {
    renderAll(<PricingHealthPanel alerts={alerts()} />);
    const alert = document.querySelector('[data-pricing-alert="HUCHA_FEE_BELOW_GATEWAY_COST"]') as HTMLElement;
    expect(within(alert).getByTestId('pricing-adjust')).toHaveAttribute('href', '/admin/reglas#rule-topupFeeCents');
  });

  it('un aviso que ya cambió o caducó la sesión se explica con su texto', async () => {
    rulesActions.acknowledgePricingAlertAction.mockResolvedValue({ status: 'REJECTED', reason: 'ALERT_CHANGED', fields: [] });
    renderAll(<PricingHealthPanel alerts={alerts()} />);
    const alert = document.querySelector('[data-pricing-alert="HUCHA_FEE_BELOW_GATEWAY_COST"]') as HTMLElement;
    await userEvent.click(within(alert).getByTestId('pricing-accept'));
    await userEvent.type(within(alert).getByTestId('pricing-note'), 'Nota suficientemente larga');
    await userEvent.click(within(alert).getByTestId('pricing-accept-submit'));
    expect(await within(alert).findByText(/este aviso ya es otro/)).toBeInTheDocument();
  });
});

describe('QA-A04 · medallas y categorías globales', () => {
  const TIERS = [
    { key: 'bronze', icon: '🥉', campaignsRequired: 1, grantCents: 50_000 },
    { key: 'silver', icon: '🥈', campaignsRequired: 2, grantCents: 100_000 },
    { key: 'gold', icon: '🥇', campaignsRequired: 3, grantCents: 200_000 }
  ];

  it('las medallas se guardan con campañas enteras y becas en céntimos, con la versión que se veía', async () => {
    rulesActions.saveMedalsAction.mockResolvedValue({ status: 'DONE' });
    renderAll(<MedalsForm tiers={TIERS} updatedAt={UPDATED_AT} />);
    expect((screen.getAllByLabelText(/Beca de ampliación del exento/)[1] as HTMLInputElement).value).toBe('1000');
    const gold = screen.getAllByLabelText(/Campañas necesarias/)[2]!;
    await userEvent.clear(gold);
    await userEvent.type(gold, '5');
    await userEvent.click(screen.getByTestId('medals-save'));
    await waitFor(() =>
      expect(rulesActions.saveMedalsAction).toHaveBeenCalledWith({
        medals: [
          { key: 'bronze', campaignsRequired: 1, grantCents: 50_000 },
          { key: 'silver', campaignsRequired: 2, grantCents: 100_000 },
          { key: 'gold', campaignsRequired: 5, grantCents: 200_000 }
        ],
        expectedUpdatedAt: UPDATED_AT
      })
    );
  });

  it('niveles que no suben o importes imposibles no salen al servidor y se explican', async () => {
    renderAll(<MedalsForm tiers={TIERS} updatedAt={UPDATED_AT} />);
    const gold = screen.getAllByLabelText(/Campañas necesarias/)[2]!;
    await userEvent.clear(gold);
    await userEvent.type(gold, '2');
    await userEvent.click(screen.getByTestId('medals-save'));
    expect(rulesActions.saveMedalsAction).not.toHaveBeenCalled();
    expect(screen.getByText(/Cada medalla debe pedir más campañas que la anterior/)).toHaveAttribute('role', 'alert');

    await userEvent.clear(gold);
    await userEvent.type(gold, '3');
    const grant = screen.getAllByLabelText(/Beca de ampliación del exento/)[0]!;
    await userEvent.clear(grant);
    await userEvent.type(grant, '12,345');
    await userEvent.click(screen.getByTestId('medals-save'));
    expect(rulesActions.saveMedalsAction).not.toHaveBeenCalled();
    expect(grant).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(grant).toHaveFocus(), { timeout: 4000 });
  });

  it('cambiar la regla de una categoría pide confirmar y se puede cancelar con Escape devolviendo el foco', async () => {
    rulesActions.setGlobalCategoryRuleAction.mockResolvedValue({ status: 'DONE' });
    renderAll(<GlobalCategories categories={[{ name: 'Patios y Deporte', icon: '🌳', rule: 'BRACKETS' }, { name: 'Comedor', icon: '🍽️', rule: 'EXEMPT' }]} />);
    const select = screen.getByTestId('category-rule-0');
    fireEvent.change(select, { target: { value: 'EXEMPT' } });
    const confirm = await screen.findByTestId('global-category-confirm');
    expect(confirm).toHaveTextContent(/«Patios y Deporte» pasará a estar exenta \(0 %\)/);
    expect(rulesActions.setGlobalCategoryRuleAction).not.toHaveBeenCalled();
    fireEvent.keyDown(confirm, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('global-category-confirm')).toBeNull());
    await waitFor(() => expect(select).toHaveFocus(), { timeout: 4000 });

    fireEvent.change(select, { target: { value: 'EXEMPT' } });
    await userEvent.click(await screen.findByTestId('global-category-confirm-yes'));
    await waitFor(() => expect(rulesActions.setGlobalCategoryRuleAction).toHaveBeenCalledWith({ category: { name: 'Patios y Deporte', rule: 'EXEMPT' } }));
  });

  it('crear una categoría ya exenta pide confirmar como al pasar una existente a exenta; Escape cancela', async () => {
    rulesActions.addGlobalCategoryAction.mockResolvedValue({ status: 'DONE' });
    renderAll(<GlobalCategories categories={[{ name: 'Comedor', icon: '🍽️', rule: 'EXEMPT' }]} />);
    await userEvent.type(screen.getByTestId('category-new-name'), 'Huerto');
    await userEvent.selectOptions(screen.getByLabelText('Regla de la nueva categoría'), 'EXEMPT');
    await userEvent.click(screen.getByTestId('category-add'));
    const confirm = await screen.findByTestId('category-add-confirm');
    expect(confirm).toHaveTextContent('«Huerto» se creará exenta (0 %)');
    expect(rulesActions.addGlobalCategoryAction).not.toHaveBeenCalled();
    fireEvent.keyDown(confirm, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('category-add-confirm')).toBeNull());
    await userEvent.click(screen.getByTestId('category-add'));
    await userEvent.click(await screen.findByTestId('category-add-confirm-yes'));
    await waitFor(() => expect(rulesActions.addGlobalCategoryAction).toHaveBeenCalledWith({ category: { name: 'Huerto', rule: 'EXEMPT' } }));
  });

  it('añadir una categoría global pide un nombre y explica el rechazo de una repetida junto al campo', async () => {
    rulesActions.addGlobalCategoryAction.mockResolvedValue({ status: 'REJECTED', reason: 'CATEGORY_EXISTS', fields: ['name'] });
    renderAll(<GlobalCategories categories={[{ name: 'Comedor', icon: '🍽️', rule: 'EXEMPT' }]} />);
    const add = screen.getByTestId('category-add');
    expect(add).toBeDisabled();
    await userEvent.type(screen.getByTestId('category-new-name'), 'Comedor');
    await userEvent.click(add);
    await waitFor(() => expect(rulesActions.addGlobalCategoryAction).toHaveBeenCalledWith({ category: { name: 'Comedor', rule: 'BRACKETS' } }));
    expect(await screen.findByText(/que no exista ya como categoría global/)).toBeInTheDocument();
    expect(screen.getByTestId('category-new-name')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('QA-A04 · bandeja de soporte de KORUM', () => {
  const TICKET: ConsoleTicket = {
    ticketCode: 'TCK-7K3M9Q',
    origin: 'CEIP Cervantes',
    orgSlug: 'ceip-cervantes',
    fromOrganization: false,
    topic: 'PAYMENT',
    subject: 'No me llega el recibo',
    message: 'Pagué ayer y no he recibido nada.',
    status: 'OPEN',
    replyMessage: null,
    senderEmail: 'familia@correo.example',
    createdAt: '2026-11-11T10:00:00.000Z',
    repliedAt: null,
    resolvedAt: null,
    canNotify: true,
    accountName: null,
    rectification: null
  };
  const card = (overrides: Partial<ConsoleTicket> = {}) => renderAll(<ol><SupportTicketCard ticket={{ ...TICKET, ...overrides }} /></ol>);

  it('el enlace al panel de la entidad es un botón de 44 px, fuera del texto, y solo existe si la consulta viene de una entidad', () => {
    const { unmount } = card();
    const link = screen.getByTestId('ticket-open-panel');
    expect(link).toHaveAttribute('href', '/panel/ceip-cervantes');
    expect(link.className).toContain('min-h-11');
    expect(link.closest('p')).toBeNull();
    unmount();
    card({ orgSlug: null });
    expect(screen.queryByTestId('ticket-open-panel')).toBeNull();
  });

  it('tras contestar sin cerrar, el foco va al título de la propia consulta (no pierde su sitio); si la cierra, al titular de las que esperan', async () => {
    supportActions.answerPlatformTicketAction.mockResolvedValue({ status: 'OK', ticketCode: TICKET.ticketCode, resolved: false, notified: true });
    renderAll(
      <>
        <h2 id="waiting-title" tabIndex={-1}>Esperan</h2>
        <ol><SupportTicketCard ticket={TICKET} /></ol>
      </>
    );
    await userEvent.type(screen.getByTestId('ticket-reply'), 'Te hemos reenviado el recibo.');
    await userEvent.click(screen.getByTestId('ticket-submit'));
    await waitFor(() => expect(document.getElementById('ticket-title-TCK-7K3M9Q')).toHaveFocus(), { timeout: 4000 });
  });

  it('contesta con el texto escrito y el estado elegido, y avisa de si salió el email', async () => {
    supportActions.answerPlatformTicketAction.mockResolvedValue({ status: 'OK', ticketCode: TICKET.ticketCode, resolved: false, notified: true });
    card();
    expect(screen.getByTestId('ticket-submit')).toBeDisabled();
    await userEvent.type(screen.getByTestId('ticket-reply'), 'Te hemos reenviado el recibo.');
    await userEvent.click(screen.getByTestId('ticket-submit'));
    await waitFor(() => expect(supportActions.answerPlatformTicketAction).toHaveBeenCalledWith({ ticketCode: 'TCK-7K3M9Q', reply: 'Te hemos reenviado el recibo.' }));
    expect(await screen.findByText(/actualizada y aviso enviado/)).toBeInTheDocument();
  });

  it('una consulta ya contestada solo deja cambiar el estado; cerrarla pide confirmar; una resuelta no tiene formulario', async () => {
    supportActions.answerPlatformTicketAction.mockResolvedValue({ status: 'OK', ticketCode: TICKET.ticketCode, resolved: true, notified: false });
    const { unmount } = card({ status: 'IN_PROGRESS', replyMessage: 'Ya está enviado.', repliedAt: '2026-11-11T12:00:00.000Z' });
    expect(screen.queryByTestId('ticket-reply')).toBeNull();
    expect(screen.getByText(/ya tiene respuesta: solo puedes cambiar su estado/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByTestId('ticket-status'), 'RESOLVED');
    await userEvent.click(screen.getByTestId('ticket-submit'));
    expect(await screen.findByTestId('ticket-resolve-confirm')).toHaveTextContent('Esta consulta ya tiene respuesta. Se cerrará y no se podrá volver a contestar.');
    expect(supportActions.answerPlatformTicketAction).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('ticket-resolve-yes'));
    await waitFor(() => expect(supportActions.answerPlatformTicketAction).toHaveBeenCalledWith({ ticketCode: 'TCK-7K3M9Q', status: 'RESOLVED' }));
    unmount();
    card({ status: 'RESOLVED', replyMessage: 'Ya está enviado.', resolvedAt: '2026-11-11T13:00:00.000Z' });
    expect(screen.queryByTestId('ticket-submit')).toBeNull();
  });

  it('cerrar una consulta que ya tiene respuesta lo dice con verdad: no afirma que se cierra sin responder', async () => {
    supportActions.answerPlatformTicketAction.mockResolvedValue({ status: 'OK', ticketCode: TICKET.ticketCode, resolved: true, notified: false });
    card({ status: 'IN_PROGRESS', replyMessage: 'Ya está enviado.', repliedAt: '2026-11-11T12:00:00.000Z' });
    await userEvent.selectOptions(screen.getByTestId('ticket-status'), 'RESOLVED');
    await userEvent.click(screen.getByTestId('ticket-submit'));
    const confirm = await screen.findByTestId('ticket-resolve-confirm');
    expect(confirm).toHaveTextContent('Esta consulta ya tiene respuesta. Se cerrará y no se podrá volver a contestar.');
    expect(confirm).not.toHaveTextContent('sin responder');
  });

  it('cerrar la consulta con una respuesta escrita lo dice en la confirmación; sin dirección de contacto avisa de que nadie recibirá el aviso', async () => {
    supportActions.answerPlatformTicketAction.mockResolvedValue({ status: 'OK', ticketCode: TICKET.ticketCode, resolved: true, notified: false });
    card({ senderEmail: null, canNotify: false });
    expect(screen.getByText(/No se podrá avisar a esta persona/)).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('ticket-reply'), 'Respuesta que se guardará aunque nadie la reciba.');
    await userEvent.selectOptions(screen.getByTestId('ticket-status'), 'RESOLVED');
    await userEvent.click(screen.getByTestId('ticket-submit'));
    expect(await screen.findByTestId('ticket-resolve-confirm')).toHaveTextContent('Se enviará tu respuesta y la consulta quedará resuelta');
    await userEvent.click(screen.getByTestId('ticket-resolve-yes'));
    expect(await screen.findByText(/No se ha avisado por email: esa persona ya no tiene cuenta/)).toBeInTheDocument();
  });

  it('las de una entidad llevan la marca de prioridad con texto; el rechazo se explica sin perder lo escrito', async () => {
    supportActions.answerPlatformTicketAction.mockResolvedValue({ status: 'ERROR', reason: 'ALREADY_REPLIED' });
    card({ fromOrganization: true });
    expect(screen.getByTestId('ticket-priority')).toHaveTextContent('Prioritaria: de una entidad');
    await userEvent.type(screen.getByTestId('ticket-reply'), 'Una respuesta válida de largo.');
    await userEvent.click(screen.getByTestId('ticket-submit'));
    expect(await screen.findByText(/ya tenía respuesta/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('ticket-submit')).toHaveFocus(), { timeout: 4000 });
    expect(screen.getByTestId('ticket-reply')).toHaveValue('Una respuesta válida de largo.');
  });

  it('una rectificación enseña su plazo (y avisa si venció) y se cierra con el cambio hecho', async () => {
    supportActions.closeRectificationAction.mockResolvedValue({ status: 'CLOSED' });
    card({ topic: 'RECTIFICATION', rectification: { requestId: 4, status: 'RECEIVED', dueAt: '2026-11-01T00:00:00.000Z', overdue: true } });
    const block = screen.getByTestId('rectification');
    expect(block).toHaveTextContent(/plazo legal de un mes venció/);
    await userEvent.click(within(block).getByTestId('rectification-done'));
    await waitFor(() => expect(supportActions.closeRectificationAction).toHaveBeenCalledWith({ ticketCode: 'TCK-7K3M9Q', outcome: 'COMPLETED' }));
  });

  it('rechazar una rectificación pide confirmar y explica qué pasa; un fallo de red no culpa a la nota; se corrige el nombre de la cuenta desde aquí', async () => {
    supportActions.closeRectificationAction.mockRejectedValueOnce(new Error('red')).mockResolvedValue({ status: 'CLOSED' });
    supportActions.rectifyNameAction.mockResolvedValue({ status: 'DONE' });
    card({ topic: 'RECTIFICATION', accountName: 'Ana Lopes Garcia', rectification: { requestId: 4, status: 'RECEIVED', dueAt: '2026-12-01T00:00:00.000Z', overdue: false } });
    const block = screen.getByTestId('rectification');
    expect(block).toHaveTextContent('El cambio de email todavía no se puede hacer');
    expect(block).toHaveTextContent('Nombre actual de la cuenta: Ana Lopes Garcia');
    await userEvent.type(within(block).getByTestId('rectification-name'), 'Ana López García');
    await userEvent.click(within(block).getByTestId('rectification-rename'));
    await waitFor(() => expect(supportActions.rectifyNameAction).toHaveBeenCalledWith({ ticketCode: 'TCK-7K3M9Q', name: 'Ana López García' }));
    await waitFor(() => expect(supportActions.rectifyNameAction).toHaveBeenCalledTimes(1));

    await userEvent.click(within(block).getByTestId('rectification-reject'));
    expect(within(block).getByTestId('rectification-reject-confirm')).toHaveTextContent('Rechazar cierra la solicitud sin hacer el cambio');
    expect(supportActions.closeRectificationAction).not.toHaveBeenCalled();
    await userEvent.click(within(block).getByTestId('rectification-reject-yes'));
    expect(await within(block).findByText(/Recarga la página y comprueba si la solicitud sigue abierta/)).toBeInTheDocument();
    expect(block).not.toHaveTextContent('Revisa la nota');
  });

  it('el email directo a la entidad pide asunto y mensaje con su longitud, y dice a cuántas personas salió', async () => {
    supportActions.sendDirectEmailAction.mockResolvedValue({ status: 'SENT', recipients: 2 });
    renderAll(<OrgDirectEmail organizationId="CERVANTES" organizationName="CEIP Cervantes" disabled={false} />);
    const send = screen.getByTestId('direct-send');
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByTestId('direct-subject'), 'Revisión de documentos');
    await userEvent.type(screen.getByTestId('direct-message'), 'Hola, hemos revisado todo y está en orden.');
    await userEvent.click(send);
    // Antes de enviar hay una confirmación con la entidad: un email enviado no se puede retirar.
    expect(await screen.findByTestId('direct-confirm')).toHaveTextContent('Se enviará a quienes firman por CEIP Cervantes, con el nombre de KORUM');
    expect(supportActions.sendDirectEmailAction).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('direct-confirm-yes'));
    await waitFor(() => expect(supportActions.sendDirectEmailAction).toHaveBeenCalledWith({ organizationId: 'CERVANTES', email: { subject: 'Revisión de documentos', message: 'Hola, hemos revisado todo y está en orden.' } }));
    expect(await screen.findByText('Email enviado a 2 personas.')).toBeInTheDocument();
    expect(screen.getByTestId('direct-subject')).toHaveValue('');
  });

  it('mientras se pide confirmar crear una categoría exenta, el nombre y la regla no se pueden cambiar', async () => {
    renderAll(<GlobalCategories categories={[{ name: 'Comedor', icon: '🍽️', rule: 'EXEMPT' }]} />);
    await userEvent.type(screen.getByTestId('category-new-name'), 'Huerto');
    await userEvent.selectOptions(screen.getByLabelText('Regla de la nueva categoría'), 'EXEMPT');
    await userEvent.click(screen.getByTestId('category-add'));
    await screen.findByTestId('category-add-confirm');
    expect(screen.getByTestId('category-new-name')).toBeDisabled();
    expect(screen.getByLabelText('Regla de la nueva categoría')).toBeDisabled();
  });

  it('un texto con un enlace o una dirección no se puede enviar y se explica antes de pulsar nada', async () => {
    renderAll(<OrgDirectEmail organizationId="CERVANTES" organizationName="CEIP Cervantes" disabled={false} />);
    await userEvent.type(screen.getByTestId('direct-subject'), 'Revisión de documentos');
    await userEvent.type(screen.getByTestId('direct-message'), 'Entra en https://korum-soporte.example/login para revisarlo todo.');
    expect(screen.getByTestId('direct-send')).toBeDisabled();
    expect(screen.getByTestId('direct-message')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/no pueden llevar enlaces ni direcciones web o de email/)).toBeInTheDocument();
  });

  it('una entidad archivada no recibe el formulario del email directo', () => {
    renderAll(<OrgDirectEmail organizationId="CERVANTES" organizationName="CEIP Cervantes" disabled />);
    expect(screen.queryByTestId('direct-send')).toBeNull();
    expect(screen.getByText(/está archivada/)).toBeInTheDocument();
  });
});

describe('QA-A04 · dinero que se resuelve con Paycomet', () => {
  it('la alerta de un reparto bloqueado enseña las cifras y los pasos, avisa de que KORUM no mueve dinero y no se cierra sin nota', async () => {
    consoleActions.resolveAlertWithNoteAction.mockResolvedValue({ status: 'RESOLVED' });
    renderAll(<BlockedMoneyAlert alertId="a1" type="PAYOUT_BLOCKED" figures={{ reason: null, amountCents: 100_000, blockedCents: 30_000, stuckCents: null, availableCents: null, deadline: null }} describedBy="titulo" />);
    const box = screen.getByTestId('blocked-money');
    expect(box).toHaveTextContent('300,00 € que no se pueden enviar');
    expect(box).toHaveTextContent('Importe de la liquidación: 1.000,00 €');
    expect(box).toHaveTextContent('KORUM no mueve dinero desde aquí');
    expect(box).toHaveTextContent('Cerrarla no arregla el problema');
    expect(screen.getByTestId('blocked-resolve')).toHaveTextContent('Dejar constancia y cerrar la alerta');
    expect(within(box).getAllByRole('listitem')).toHaveLength(3);
    const resolve = screen.getByTestId('blocked-resolve');
    expect(resolve).toBeDisabled();
    await userEvent.type(screen.getByTestId('blocked-note'), 'Paycomet repondrá el importe por escrito.');
    await userEvent.click(resolve);
    await waitFor(() => expect(consoleActions.resolveAlertWithNoteAction).toHaveBeenCalledWith({ alertId: 'a1', note: 'Paycomet repondrá el importe por escrito.' }));
  });

  it('sin las cifras el texto no queda roto: una variante genérica en vez de «tiene — que no se pueden enviar»', () => {
    const { unmount } = renderAll(<BlockedMoneyAlert alertId="a4" type="PAYOUT_BLOCKED" figures={null} describedBy="t" />);
    expect(screen.getByTestId('blocked-money')).toHaveTextContent('tiene dinero que no se puede enviar');
    expect(screen.getByTestId('blocked-money')).not.toHaveTextContent('—');
    unmount();
    renderAll(<BlockedMoneyAlert alertId="a5" type="ACTIVITY_FUND_WINDOW" figures={{ reason: 'SIGNED_NOT_APPROVED', amountCents: 25_000, blockedCents: null, stuckCents: null, availableCents: null, deadline: null }} describedBy="t" />);
    expect(screen.getByTestId('blocked-money')).toHaveTextContent('está a punto de vencer');
    expect(screen.getByTestId('blocked-money')).not.toHaveTextContent('vence el .');
  });

  it('según el caso del Fondo cambia el texto (firmada sin aprobar frente a dinero fuera de la ventana)', () => {
    const { unmount } = renderAll(<BlockedMoneyAlert alertId="a2" type="ACTIVITY_FUND_WINDOW" figures={{ reason: 'SIGNED_NOT_APPROVED', amountCents: 25_000, blockedCents: null, stuckCents: null, availableCents: null, deadline: '2026-12-01T00:00:00.000Z' }} describedBy="t" />);
    expect(screen.getByTestId('blocked-money')).toHaveAttribute('data-kind', 'unsigned');
    expect(screen.getByTestId('blocked-money')).toHaveTextContent(/vence el 1 dic 2026|vence el 1 de diciembre de 2026|1 dic/);
    unmount();
    renderAll(<BlockedMoneyAlert alertId="a3" type="ACTIVITY_FUND_WINDOW" figures={{ reason: null, amountCents: null, blockedCents: null, stuckCents: 25_000, availableCents: 0, deadline: null }} describedBy="t" />);
    expect(screen.getByTestId('blocked-money')).toHaveAttribute('data-kind', 'window');
    expect(screen.getByTestId('blocked-money')).toHaveTextContent(/250,00 € ya no se puede repartir/);
  });

  const SPLIT = { kind: 'CAMPAIGN' as const, splitId: 8, payoutId: 3, organizationName: 'CEIP Cervantes', organizationSlug: 'ceip', amountCents: 30_000, paycometOrder: 'KO-123', destinationSplitId: 'SPLIT-9', sentAt: '2026-11-12T08:00:00.000Z' };

  it('un reparto de resultado desconocido pide elegir qué pasó en Paycomet; «sí salió» exige el código', async () => {
    consoleActions.resolveSplitAction.mockResolvedValue({ status: 'RESOLVED', done: true });
    renderAll(<SplitsToResolve splits={[SPLIT]} />);
    expect(screen.getByText(/Liquidación de campaña: 300,00 € para CEIP Cervantes/)).toBeInTheDocument();
    expect(screen.getByText('KO-123')).toBeInTheDocument();
    const submit = screen.getByTestId('split-submit');
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/Sí salió/));
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Código de autorización/), 'S-COMPROBADO');
    expect(screen.getByText(/la entidad no cobrará ese importe/)).toBeInTheDocument();
    await userEvent.click(submit);
    // Una confirmación final antes de tocar el libro mayor.
    expect(await screen.findByTestId('split-confirm')).toHaveTextContent('con el código S-COMPROBADO');
    expect(consoleActions.resolveSplitAction).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('split-confirm-yes'));
    await waitFor(() => expect(consoleActions.resolveSplitAction).toHaveBeenCalledWith({ kind: 'CAMPAIGN', splitId: 8, splitAuthCode: 'S-COMPROBADO' }));
  });

  it('«no salió» no pide código y lo manda como null; si caducó el segundo factor lo dice y enlaza', async () => {
    consoleActions.resolveSplitAction.mockResolvedValueOnce({ status: 'REAUTH_REQUIRED' }).mockResolvedValueOnce({ status: 'RESOLVED', done: false });
    renderAll(<SplitsToResolve splits={[{ ...SPLIT, kind: 'FUND' }]} />);
    await userEvent.click(screen.getByLabelText(/No salió/));
    expect(screen.queryByLabelText(/Código de autorización/)).toBeNull();
    // «No salió» también avisa: si en realidad sí salió, la entidad cobraría dos veces.
    expect(screen.getByText(/la entidad cobrará ese importe dos veces/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('split-submit'));
    await userEvent.click(await screen.findByTestId('split-confirm-yes'));
    await waitFor(() => expect(consoleActions.resolveSplitAction).toHaveBeenCalledWith({ kind: 'FUND', splitId: 8, splitAuthCode: null }));
    expect(await screen.findByRole('link', { name: 'Volver a verificar mi identidad' })).toBeInTheDocument();
  });

  it('sin repartos por resolver lo dice', () => {
    renderAll(<SplitsToResolve splits={[]} />);
    expect(screen.getByText('No hay repartos pendientes de resolver.')).toBeInTheDocument();
  });
});
