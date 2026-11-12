import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgCategories } from '@/components/admin/org-categories';
import { OrgKybReview } from '@/components/admin/org-kyb-review';
import { OrgSeats } from '@/components/admin/org-seats';
import { OrgTariffsForm, parseTariffText, toInputText } from '@/components/admin/org-tariffs-form';
import { InitiativePopup } from '@/components/admin/initiative-popup';
import { RequeueEmailsButton } from '@/components/admin/alert-actions';
import { ToastProvider } from '@/components/ui/toast-provider';
import type { TariffValues } from '@/core/admin/org-360-rules';
import { buildBiInitiativeRow } from '@/core/finance/bi-aggregate';
import { LOCALES, type Locale } from '@/i18n/routing';
import type { InitiativePopupView } from '@/services/admin/initiative-popup';
import type { Org360View } from '@/services/admin/org-360-data';
import { renderWithIntl } from '../utils/render-with-intl';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, prefetch: _prefetch, ...props }: { href: string | { pathname: string }; children: ReactNode; prefetch?: boolean }) => (
    <a href={typeof href === 'string' ? href : href.pathname} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({ refresh: vi.fn() })
}));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const entityActions = { reviewKybAction: vi.fn(), releaseCifAction: vi.fn(), saveTariffsAction: vi.fn(), setCategoryRuleAction: vi.fn(), addCategoryAction: vi.fn() };
vi.mock('@/app/[locale]/(superadmin)/admin/entidades/actions', () => ({
  reviewKybAction: (...args: unknown[]) => entityActions.reviewKybAction(...args),
  releaseCifAction: (...args: unknown[]) => entityActions.releaseCifAction(...args),
  saveTariffsAction: (...args: unknown[]) => entityActions.saveTariffsAction(...args),
  setCategoryRuleAction: (...args: unknown[]) => entityActions.setCategoryRuleAction(...args),
  addCategoryAction: (...args: unknown[]) => entityActions.addCategoryAction(...args)
}));
const consoleActions = { requeueEmailsAction: vi.fn(), loadInitiativePopupAction: vi.fn(), executeSelfBoostAction: vi.fn(), fixTariffAction: vi.fn(), resolveAlertAction: vi.fn(), resolveStuckAction: vi.fn() };
vi.mock('@/app/[locale]/(superadmin)/admin/actions', () => ({
  requeueEmailsAction: (...args: unknown[]) => consoleActions.requeueEmailsAction(...args),
  loadInitiativePopupAction: (...args: unknown[]) => consoleActions.loadInitiativePopupAction(...args),
  executeSelfBoostAction: (...args: unknown[]) => consoleActions.executeSelfBoostAction(...args),
  fixTariffAction: (...args: unknown[]) => consoleActions.fixTariffAction(...args),
  resolveAlertAction: (...args: unknown[]) => consoleActions.resolveAlertAction(...args),
  resolveStuckAction: (...args: unknown[]) => consoleActions.resolveStuckAction(...args)
}));

/** Una clave de traducción sin resolver no rompe el render en las pruebas (next-intl pinta la clave y avisa por consola): se vigila aquí, porque la E2E lo detectó tarde. */
let consoleErrors: { mock: { calls: unknown[][] } };
beforeEach(() => {
  consoleErrors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  const missing = consoleErrors.mock.calls.map((call: unknown[]) => String(call[0])).filter((message: string) => message.includes('MISSING_MESSAGE'));
  expect(missing).toEqual([]);
  vi.clearAllMocks();
});

const GLOBAL: TariffValues = { exemptLimitCents: 100_000, t1Bps: 500, t2Bps: 400, t3Bps: 300, sponsorFeeBps: 1_500, fullIntegrityCheckCents: 180, ticketFeeFixedCents: 45, ticketFeeBps: 200, maintActive: false, maintPerInitCents: 4_900, maintAnnualCapCents: 14_700 };
const withToasts = (node: ReactNode) => <ToastProvider>{node}</ToastProvider>;
const renderAll = (node: ReactNode, locale: Locale = 'es') => renderWithIntl(withToasts(node), locale);

describe('QA-A03 · tarifas individuales (formulario)', () => {
  it('toInputText y parseTariffText son inversas y estrictas: sin decimales de más, sin negativos, sin texto', () => {
    expect(toInputText(4_900, ',')).toBe('49');
    expect(toInputText(180, ',')).toBe('1,80');
    expect(toInputText(180, '.')).toBe('1.80');
    expect(toInputText(5, ',')).toBe('0,05');
    expect(parseTariffText('1,80', 'es', 100_000)).toBe(180);
    expect(parseTariffText('1.80', 'en', 100_000)).toBe(180);
    expect(parseTariffText('5 %', 'es', 10_000)).toBe(500);
    expect(parseTariffText('1.234,50', 'es', 1_000_000)).toBe(123_450);
    expect(parseTariffText('4,567', 'es', 10_000)).toBeNull();
    expect(parseTariffText('-1', 'es', 10_000)).toBeNull();
    expect(parseTariffText('abc', 'es', 10_000)).toBeNull();
    expect(parseTariffText('', 'es', 10_000)).toBeNull();
    expect(parseTariffText('101', 'es', 10_000)).toBeNull();
  });

  it('con las tarifas globales los campos se ven, bloqueados, y guardar vuelve a las globales', async () => {
    entityActions.saveTariffsAction.mockResolvedValue({ status: 'DONE' });
    renderAll(<OrgTariffsForm organizationId="CERVANTES" customRules={false} tariffs={GLOBAL} globalTariffs={GLOBAL} />);
    const field = screen.getByLabelText(/Tramo 1/);
    expect(field).toBeDisabled();
    expect((field as HTMLInputElement).value).toBe('5');
    expect(screen.getByTestId('tariffs-mode')).toHaveTextContent('valores globales');
    await userEvent.click(screen.getByTestId('tariffs-save'));
    await waitFor(() => expect(entityActions.saveTariffsAction).toHaveBeenCalledWith({ organizationId: 'CERVANTES', tariffs: { customRules: false } }));
  });

  it('encendida la tarifa propia, guarda enteros en céntimos y puntos básicos', async () => {
    entityActions.saveTariffsAction.mockResolvedValue({ status: 'DONE' });
    renderAll(<OrgTariffsForm organizationId="CERVANTES" customRules={false} tariffs={GLOBAL} globalTariffs={GLOBAL} />);
    await userEvent.click(screen.getByTestId('tariffs-custom'));
    const t1 = screen.getByLabelText(/Tramo 1/);
    expect(t1).toBeEnabled();
    fireEvent.change(t1, { target: { value: '5,5' } });
    fireEvent.change(screen.getByLabelText(/Gastos de gestión digital fijos/), { target: { value: '0,50' } });
    await userEvent.click(screen.getByTestId('tariffs-save'));
    await waitFor(() => expect(entityActions.saveTariffsAction).toHaveBeenCalledTimes(1));
    const payload = entityActions.saveTariffsAction.mock.calls[0]![0] as { tariffs: Record<string, unknown> };
    expect(payload.tariffs).toMatchObject({ customRules: true, t1Bps: 550, ticketFeeFixedCents: 50, exemptLimitCents: 100_000, maintActive: false });
    // Todo lo que viaja son enteros.
    for (const value of Object.values(payload.tariffs)) if (typeof value === 'number') expect(Number.isInteger(value)).toBe(true);
  });

  it('un valor imposible marca su campo, lo anuncia y no llama al servidor', async () => {
    renderAll(<OrgTariffsForm organizationId="CERVANTES" customRules tariffs={GLOBAL} globalTariffs={GLOBAL} />);
    const t2 = screen.getByLabelText(/Tramo 2/);
    fireEvent.change(t2, { target: { value: '4,567' } });
    await userEvent.click(screen.getByTestId('tariffs-save'));
    expect(entityActions.saveTariffsAction).not.toHaveBeenCalled();
    expect(t2).toHaveAttribute('aria-invalid', 'true');
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((alert) => alert.textContent?.includes('positivo'))).toBe(true);
  });

  it('si caducó el segundo factor lo dice y enlaza a verificar otra vez', async () => {
    entityActions.saveTariffsAction.mockResolvedValue({ status: 'REAUTH_REQUIRED' });
    renderAll(<OrgTariffsForm organizationId="CERVANTES" customRules tariffs={GLOBAL} globalTariffs={GLOBAL} />);
    await userEvent.click(screen.getByTestId('tariffs-save'));
    expect(await screen.findByTestId('entity-outcome')).toHaveTextContent('código de verificación');
    expect(screen.getByRole('link', { name: /verificar mi identidad/i })).toHaveAttribute('href', expect.stringContaining('/acceso/doble-factor'));
  });
});

const ORG: Org360View['organization'] = {
  id: 'SOL',
  slug: 'colegio-sol',
  name: 'Colegio Sol',
  legalName: 'AFA Colegio Sol',
  legalForm: 'PARENTS_ASSOCIATION',
  vertical: 'SCHOOL',
  province: 'Madrid',
  city: null,
  cif: 'G08451296',
  ibanHint: 'ES•• •••• 1332',
  walletId: 'WLT-ORG-SOL',
  splitConfigured: false,
  kybStatus: 'SUBMITTED',
  kybSubmittedAt: '2026-11-05T10:00:00.000Z',
  kybReviewedAt: null,
  kybReviewNote: null,
  ley49: true,
  ley49VerifiedAt: null,
  medalRank: 0,
  completedThisYear: 0,
  completedHistorical: 0,
  activeSponsorsCount: 0,
  historicalSponsorsCount: 0,
  archived: false,
  signatureMode: 'DOUBLE'
};
const ALL_DOCS: Org360View['documents'] = ['TAX_ID_CARD', 'STATUTES', 'REPRESENTATIVE_ID', 'ACCOUNT_OWNERSHIP', 'LEY49_ACCREDITATION'].map((kind, index) => ({ id: index + 1, kind, createdAt: '2026-11-05T09:00:00.000Z' }));

describe('QA-A03 · revisión del KYB (formulario)', () => {
  it('lista los documentos con su enlace de apertura (con la entidad en la dirección) y avisa de lo que falta', () => {
    renderAll(<OrgKybReview organization={ORG} documents={ALL_DOCS.slice(0, 3)} />);
    const list = screen.getByTestId('kyb-documents');
    const links = within(list).getAllByRole('link');
    expect(links[0]).toHaveAttribute('href', '/api/panel/documentos/1?orgSlug=colegio-sol');
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(links[0]).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(within(list).getAllByText('Falta').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('kyb-review-form')).toHaveTextContent('Faltan documentos');
    // Faltando documentos no se puede verificar.
    expect(screen.getByTestId('kyb-submit')).toBeDisabled();
  });

  it('verificar con todo presente: la Ley 49/2002 no va marcada de antemano; al acreditarla y escribir el identificador de la cuenta destino, se envían', async () => {
    entityActions.reviewKybAction.mockResolvedValue({ status: 'DONE', detail: 'VERIFIED' });
    renderAll(<OrgKybReview organization={ORG} documents={ALL_DOCS} />);
    expect(screen.getByRole('checkbox', { name: /acredita el régimen/i })).not.toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: /acredita el régimen/i }));
    fireEvent.change(screen.getByLabelText(/Identificador de la cuenta destino/), { target: { value: ' mock-split-sol ' } });
    await userEvent.click(screen.getByTestId('kyb-submit'));
    await waitFor(() => expect(entityActions.reviewKybAction).toHaveBeenCalledWith({ organizationId: 'SOL', review: { decision: 'VERIFIED', ley49Accredited: true, paycometSplitId: 'mock-split-sol' } }));
  });

  it('devolver exige una nota sin datos personales: la corta y la que lleva un email se rechazan antes de enviar', async () => {
    entityActions.reviewKybAction.mockResolvedValue({ status: 'DONE', detail: 'REJECTED' });
    renderAll(<OrgKybReview organization={ORG} documents={ALL_DOCS.slice(0, 4)} />);
    await userEvent.click(screen.getByRole('radio', { name: /Devolver los documentos/ }));
    const note = screen.getByTestId('kyb-note');
    fireEvent.change(note, { target: { value: 'corta' } });
    await userEvent.click(screen.getByTestId('kyb-submit'));
    expect(entityActions.reviewKybAction).not.toHaveBeenCalled();
    expect(await screen.findByText(/al menos 10 caracteres/)).toBeInTheDocument();
    fireEvent.change(note, { target: { value: 'Escribid a afa@sol.example con el acta' } });
    await userEvent.click(screen.getByTestId('kyb-submit'));
    expect(entityActions.reviewKybAction).not.toHaveBeenCalled();
    expect(await screen.findByText(/dato personal/)).toBeInTheDocument();
    fireEvent.change(note, { target: { value: 'Falta la página con la firma del acta fundacional' } });
    await userEvent.click(screen.getByRole('checkbox', { name: /Liberar también el CIF/ }));
    await userEvent.click(screen.getByTestId('kyb-submit'));
    await waitFor(() => expect(entityActions.reviewKybAction).toHaveBeenCalledWith({ organizationId: 'SOL', review: { decision: 'REJECTED', note: 'Falta la página con la firma del acta fundacional', releaseCif: true } }));
  });

  it('sin documentos en revisión no hay formulario de decisión; una devuelta enseña la nota; el CIF se puede liberar hasta verificar', async () => {
    entityActions.releaseCifAction.mockResolvedValue({ status: 'DONE' });
    const { unmount } = renderAll(<OrgKybReview organization={{ ...ORG, kybStatus: 'REJECTED', kybReviewNote: 'Falta la firma del acta' }} documents={ALL_DOCS} />);
    expect(screen.queryByTestId('kyb-review-form')).not.toBeInTheDocument();
    expect(screen.getByText(/Falta la firma del acta/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('release-cif'));
    // Quitar el CIF pide confirmación: hasta confirmar no se llama al servidor.
    expect(entityActions.releaseCifAction).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: /Confirma/ })).toHaveTextContent('G08451296');
    await userEvent.click(screen.getByTestId('release-cif-confirm'));
    await waitFor(() => expect(entityActions.releaseCifAction).toHaveBeenCalledWith({ organizationId: 'SOL' }));
    unmount();
    renderAll(<OrgKybReview organization={{ ...ORG, kybStatus: 'VERIFIED' }} documents={ALL_DOCS} />);
    expect(screen.queryByTestId('release-cif')).not.toBeInTheDocument();
  });

  it.each(LOCALES)('el estado y la decisión salen en %s', (locale) => {
    renderAll(<OrgKybReview organization={ORG} documents={ALL_DOCS} />, locale);
    expect(screen.getByTestId('kyb-status')).toHaveAttribute('data-status', 'SUBMITTED');
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByTestId('kyb-submit').textContent?.length).toBeGreaterThan(5);
  });
});

describe('Sprint 5.2 · firmas de la entidad y categorías', () => {
  const seats: Org360View['seats'] = [
    { id: 1, role: 'DIRECTOR', roleLabel: 'Dirección del centro', name: 'Ana Ruiz', maskedEmail: 'an•••@sol.example', twoFactor: true, since: '2026-09-01T10:00:00.000Z' },
    { id: 2, role: 'COSIGNER', roleLabel: 'Presidencia del AMPA', name: 'Luis Gil', maskedEmail: 'lu•••@sol.example', twoFactor: false, since: '2026-11-13T10:00:00.000Z' }
  ];

  it('la consola solo consulta quién firma y cuántas firmas exige la entidad: sin botones de baja ni de confirmación, y el email sale a medias', () => {
    renderAll(<OrgSeats seats={seats} handover={null} signatureMode="DOUBLE" />);
    expect(screen.getByTestId('signature-mode')).toHaveAttribute('data-mode', 'DOUBLE');
    expect(screen.getByTestId('signature-mode')).toHaveTextContent('Doble firma');
    expect(screen.getAllByTestId('seat-since')).toHaveLength(2);
    expect(screen.getByText(/an•••@sol.example/)).toBeInTheDocument();
    expect(screen.queryByText(/@sol.example$/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/KORUM no da de baja ni confirma puestos/)).toBeInTheDocument();
  });

  it.each(LOCALES)('la firma única de la entidad se enseña con texto en %s', (locale) => {
    renderAll(<OrgSeats seats={[seats[0]!]} handover={null} signatureMode="SINGLE" />, locale);
    expect(screen.getByTestId('signature-mode')).toHaveAttribute('data-mode', 'SINGLE');
    expect(screen.getByTestId('signature-mode').textContent?.length).toBeGreaterThan(10);
  });

  it('un relevo caducado se explica con texto y sin acciones para el Super-Admin', () => {
    renderAll(<OrgSeats seats={seats} handover={{ id: 'h1', role: 'COSIGNER', expiresAt: '2026-11-01T10:00:00.000Z', expired: true }} signatureMode="DOUBLE" />);
    expect(screen.getByTestId('handover-state')).toHaveAttribute('data-expired', 'true');
    expect(screen.getByTestId('handover-state')).toHaveTextContent('Caducó');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('cambiar la regla de una categoría y crear una propia llaman al servidor con lo que se ve', async () => {
    entityActions.setCategoryRuleAction.mockResolvedValue({ status: 'DONE' });
    entityActions.addCategoryAction.mockResolvedValue({ status: 'DONE' });
    renderAll(
      <OrgCategories
        organizationId="SOL"
        categories={[
          { name: 'Patios', icon: '🌳', rule: 'BRACKETS', source: 'GLOBAL' },
          { name: 'Huerto', icon: '🥕', rule: 'EXEMPT', source: 'CUSTOM' }
        ]}
      />
    );
    const row = screen.getByText('Patios').closest('li')!;
    await userEvent.selectOptions(within(row).getByRole('combobox'), 'EXEMPT');
    // Cambia lo que se cobra en campañas nuevas: hasta confirmar no se llama al servidor, y «No» lo deja como estaba.
    expect(entityActions.setCategoryRuleAction).not.toHaveBeenCalled();
    expect(screen.getByTestId('category-rule-confirm')).toHaveTextContent('«Patios» pasará a 💚 0 % exenta en las campañas nuevas');
    await userEvent.click(screen.getByRole('button', { name: 'No, dejarla como está' }));
    expect(entityActions.setCategoryRuleAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId('category-rule-confirm')).not.toBeInTheDocument();
    await userEvent.selectOptions(within(row).getByRole('combobox'), 'EXEMPT');
    await userEvent.click(screen.getByTestId('category-rule-confirm-yes'));
    await waitFor(() => expect(entityActions.setCategoryRuleAction).toHaveBeenCalledWith({ organizationId: 'SOL', category: { name: 'Patios', rule: 'EXEMPT' } }));
    expect(screen.getByText('propia')).toBeInTheDocument();
    expect(screen.getByTestId('category-add')).toBeDisabled();
    fireEvent.change(screen.getByTestId('category-name'), { target: { value: 'Biblioteca' } });
    await userEvent.click(screen.getByTestId('category-add'));
    await waitFor(() => expect(entityActions.addCategoryAction).toHaveBeenCalledWith({ organizationId: 'SOL', category: { name: 'Biblioteca', rule: 'EXEMPT' } }));
  });
});

describe('Sprint 5.2 · alertas de email: volver a poner en cola', () => {
  it('dice cuántos mensajes volvieron a la cola y cuántos no se pueden reactivar', async () => {
    consoleActions.requeueEmailsAction.mockResolvedValue({ status: 'REQUEUED', requeued: 3, skipped: 2 });
    renderAll(<RequeueEmailsButton alertId="a1" />);
    await userEvent.click(screen.getByTestId('requeue-emails'));
    await waitFor(() => expect(consoleActions.requeueEmailsAction).toHaveBeenCalledWith({ alertId: 'a1' }));
    expect(await screen.findByText(/2 emails no se pueden reactivar/)).toBeInTheDocument();
  });

  it('una alerta que ya no está abierta lo dice, y un fallo inesperado no se queda mudo', async () => {
    consoleActions.requeueEmailsAction.mockResolvedValueOnce({ status: 'NOT_OPEN' }).mockRejectedValueOnce(new Error('boom'));
    renderAll(<RequeueEmailsButton alertId="a1" />);
    await userEvent.click(screen.getByTestId('requeue-emails'));
    expect(await screen.findByText(/ya no estaba abierta/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('requeue-emails'));
    expect(await screen.findByText(/No se ha podido poner en cola/)).toBeInTheDocument();
  });
});

const popupView = (overrides: Partial<InitiativePopupView['row']> = {}, rest: Partial<InitiativePopupView> = {}): InitiativePopupView => {
  const row = buildBiInitiativeRow({
    id: 1,
    walletEscrowId: 'WLT-ESC-101',
    title: 'Patio cubierto',
    organizationId: 'SOL',
    organizationName: 'Colegio Sol',
    organizationSlug: 'colegio-sol',
    province: 'Madrid',
    status: 'FUNDRAISING',
    format: 'BUDGET',
    quarter: '2026-Q4',
    closesAt: '2099-12-15T10:00:00.000Z',
    goalCents: 100_000,
    raisedCents: 85_000,
    totalContributions: 12,
    bracketFeeCents: 4_000,
    maintFeeCents: 0,
    gatewayFeeCents: 1_500,
    absorbsGatewayCostByKorum: false,
    realizedGuaranteeCents: 0,
    projectedGuaranteeAt100Cents: 0,
    approvedSponsorsFeeCents: 0,
    ticketMarginAt100Cents: 0,
    ticketMarginRealizedCents: 0,
    huchaTopupNetCents: 0,
    settled: { sourcesCents: { bracketFeeCents: 0, supportGuaranteeCents: 0, sponsorFeeCents: 0, digitalTicketFeeCents: 0, maintFeeCents: 0, huchaTopupFeeCents: 0 }, costsCents: 0 }
  });
  return {
    row: { ...row, isProfitableSelfBoost: true, ...overrides },
    publicPath: '/colegio-sol/iniciativas/1',
    sponsors: [{ id: 5, name: 'Panadería Luna', categoryLevel: 'ORO', status: 'APPROVED', amountCents: 25_000, feeCents: 3_750, isMatchingPool: false }],
    boost: { availableCents: 15_000, defaultDisclosure: 'SHOW', previous: [] },
    fix: null,
    ...rest
  };
};

describe('QA-A02 · pop-up ejecutivo de una iniciativa', () => {
  const open = async (view: InitiativePopupView, locale: Locale = 'es') => {
    consoleActions.loadInitiativePopupAction.mockResolvedValue({ status: 'OK', view });
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
    renderAll(<InitiativePopup initiativeId={1} onClose={vi.fn()} />, locale);
    await screen.findByTestId('popup-summary');
  };

  it('enseña enlace público, comercios participantes y el análisis con lo que falta', async () => {
    await open(popupView());
    expect(screen.getByTestId('popup-link')).toHaveTextContent('/colegio-sol/iniciativas/1');
    const sponsors = screen.getByTestId('popup-sponsors');
    expect(sponsors).toHaveTextContent('Panadería Luna');
    expect(sponsors).toHaveTextContent('Categoría ORO');
    expect(sponsors).toHaveTextContent('íntegros');
    expect(screen.getByTestId('popup-analysis')).toHaveTextContent('Falta para llegar al 100 %');
  });

  it('si la campaña reabierta ya tiene un Auto-Impulso, el análisis lo dice y lo resta del retorno (decisión del 2026-11-12)', async () => {
    await open(popupView({ recoverableSelfBoostCents: 15_000, netProfitAfterBoostCents: -7_000, isProfitableSelfBoost: false }));
    const note = screen.getByTestId('popup-recoverable-boost');
    expect(note).toHaveTextContent('Ya hay un Auto-Impulso anterior de 150,00 €');
    expect(note).toHaveTextContent('vuelve a KORUM');
  });

  it('sin Auto-Impulso anterior no sale esa nota', async () => {
    await open(popupView());
    expect(screen.queryByTestId('popup-recoverable-boost')).not.toBeInTheDocument();
  });

  it('la visibilidad del Auto-Impulso parte del valor de los ajustes y se confirma antes de gastar; envía lo que se vio', async () => {
    consoleActions.executeSelfBoostAction.mockResolvedValue({ status: 'DONE', amountCents: 15_000 });
    await open(popupView({}, { boost: { availableCents: 15_000, defaultDisclosure: 'HIDE', previous: [] } }));
    const panel = screen.getByTestId('boost-panel');
    expect(within(panel).getByRole('radio', { name: /No mostrar en público/ })).toBeChecked();
    await userEvent.click(within(panel).getByRole('radio', { name: /Mostrar en público/ }));
    await userEvent.click(screen.getByTestId('boost-start'));
    // Hasta confirmar no se gasta nada.
    expect(consoleActions.executeSelfBoostAction).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: /Confirma el Auto-Impulso/ })).toHaveTextContent('No se puede deshacer');
    await userEvent.click(screen.getByTestId('boost-confirm'));
    await waitFor(() => expect(consoleActions.executeSelfBoostAction).toHaveBeenCalledWith({ initiativeId: 1, expectedAmountCents: 15_000, publiclyDisclosed: true }));
    // El aviso de éxito vive dentro del diálogo (un aviso global quedaría tapado por el fondo modal) y recibe el foco.
    const notice = await screen.findByTestId('popup-notice');
    expect(notice).toHaveTextContent('Auto-Impulso aportado');
    await waitFor(() => expect(notice).toHaveFocus());
  });

  it('si a KORUM no le compensa, el Auto-Impulso no se ofrece hasta aceptar expresamente la pérdida, y lo aceptado viaja al servidor', async () => {
    consoleActions.executeSelfBoostAction.mockResolvedValue({ status: 'DONE', amountCents: 15_000 });
    await open(popupView({ isProfitableSelfBoost: false, netProfitAfterBoostCents: -4_000 }));
    const start = screen.getByTestId('boost-start');
    expect(start).toBeDisabled();
    expect(screen.getByTestId('boost-panel')).toHaveTextContent('no le compensa');
    await userEvent.click(screen.getByTestId('boost-accept-loss'));
    expect(start).toBeEnabled();
    await userEvent.click(start);
    await userEvent.click(screen.getByTestId('boost-confirm'));
    // Segundo mensaje de confirmación (decisión del promotor): dice lo que se pierde y hasta aceptarlo no se gasta nada.
    const second = screen.getByTestId('boost-loss-panel');
    expect(second).toHaveTextContent('no compensa a KORUM');
    expect(second).toHaveTextContent('dejará una pérdida de 40,00 €');
    expect(second).toHaveTextContent('Ese dinero no se recupera');
    expect(consoleActions.executeSelfBoostAction).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('boost-loss-confirm'));
    await waitFor(() => expect(consoleActions.executeSelfBoostAction).toHaveBeenCalledWith({ initiativeId: 1, expectedAmountCents: 15_000, publiclyDisclosed: true, acceptLoss: true }));
  });

  it('si el beneficio es exactamente cero, el segundo mensaje dice que no deja beneficio (no que haga perder)', async () => {
    await open(popupView({ isProfitableSelfBoost: false, netProfitAfterBoostCents: 0 }));
    await userEvent.click(screen.getByTestId('boost-accept-loss'));
    await userEvent.click(screen.getByTestId('boost-start'));
    await userEvent.click(screen.getByTestId('boost-confirm'));
    expect(screen.getByTestId('boost-loss-panel')).toHaveTextContent('no dejará ningún beneficio');
    expect(screen.getByTestId('boost-loss-panel')).not.toHaveTextContent('pérdida de');
  });

  it('Escape en el segundo mensaje de pérdida vuelve atrás sin gastar nada', async () => {
    await open(popupView({ isProfitableSelfBoost: false, netProfitAfterBoostCents: -4_000 }));
    await userEvent.click(screen.getByTestId('boost-accept-loss'));
    await userEvent.click(screen.getByTestId('boost-start'));
    await userEvent.click(screen.getByTestId('boost-confirm'));
    await userEvent.keyboard('{Escape}');
    expect(consoleActions.executeSelfBoostAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId('boost-loss-panel')).not.toBeInTheDocument();
  });

  it('si llegó otra aportación (AMOUNT_CHANGED), la ficha se recarga para enseñar la cifra nueva', async () => {
    consoleActions.executeSelfBoostAction.mockResolvedValue({ status: 'AMOUNT_CHANGED' });
    await open(popupView({ isProfitableSelfBoost: true }));
    const loads = consoleActions.loadInitiativePopupAction.mock.calls.length;
    await userEvent.click(screen.getByTestId('boost-start'));
    await userEvent.click(screen.getByTestId('boost-confirm'));
    expect(await screen.findByTestId('popup-problem')).toHaveTextContent(/ha cambiado mientras mirabas/);
    await waitFor(() => expect(consoleActions.loadInitiativePopupAction.mock.calls.length).toBeGreaterThan(loads));
  });

  it('en el segundo mensaje de pérdida, «No, volver» no gasta nada y deja el botón de aportar', async () => {
    await open(popupView({ isProfitableSelfBoost: false, netProfitAfterBoostCents: -4_000 }));
    await userEvent.click(screen.getByTestId('boost-accept-loss'));
    await userEvent.click(screen.getByTestId('boost-start'));
    await userEvent.click(screen.getByTestId('boost-confirm'));
    await userEvent.click(screen.getByTestId('boost-loss-back'));
    expect(consoleActions.executeSelfBoostAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId('boost-loss-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('boost-start')).toBeInTheDocument();
  });

  it('una campaña rentable no pasa por el segundo mensaje de pérdida', async () => {
    consoleActions.executeSelfBoostAction.mockResolvedValue({ status: 'DONE', amountCents: 15_000 });
    await open(popupView({ isProfitableSelfBoost: true }));
    await userEvent.click(screen.getByTestId('boost-start'));
    await userEvent.click(screen.getByTestId('boost-confirm'));
    expect(screen.queryByTestId('boost-loss-panel')).not.toBeInTheDocument();
    await waitFor(() => expect(consoleActions.executeSelfBoostAction).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['AMOUNT_CHANGED', /ha cambiado mientras mirabas/],
    ['NOT_PROFITABLE', /no le compensa/],
    ['NOT_ALLOWED', /ya no puede recibir/],
    ['REAUTH_REQUIRED', /código de verificación/]
  ])('si el servidor responde %s lo dice con texto y no da por hecho nada', async (status, message) => {
    consoleActions.executeSelfBoostAction.mockResolvedValue({ status });
    await open(popupView({ isProfitableSelfBoost: true }));
    await userEvent.click(screen.getByTestId('boost-start'));
    await userEvent.click(screen.getByTestId('boost-confirm'));
    expect(await screen.findByTestId('popup-problem')).toHaveTextContent(message);
    expect(screen.getByTestId('boost-start')).toBeInTheDocument();
  });

  it('una campaña que ya no recauda no ofrece el Auto-Impulso y enseña los que ya se aportaron, con su visibilidad', async () => {
    await open(popupView({ status: 'GOAL_REACHED', raisedCents: 100_000, missingTo100Cents: 0 }, { boost: { availableCents: 0, defaultDisclosure: 'SHOW', previous: [{ amountCents: 15_000, publiclyDisclosed: false, createdAt: '2026-11-12T10:00:00.000Z' }] } }));
    expect(screen.queryByTestId('boost-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('popup-previous-boosts')).toHaveTextContent('no mostrado en público');
  });

  it('con retorno negativo avisa con 🚨 y ofrece corregir solo si hay algo que no rompa lo prometido; una campaña publicada lo explica', async () => {
    consoleActions.fixTariffAction.mockResolvedValue({ status: 'FIXED', organizationChanged: true });
    await open(popupView({ isNegativeReturnAlert: true, isProfitableSelfBoost: false, netRevenueCents: -6_250, gatewayLossCents: 6_250 }, { fix: { available: true, publishedLeftUntouched: true } }));
    expect(screen.getByTestId('popup-negative')).toHaveTextContent('retorno negativo');
    // Con retorno negativo no se ofrece el Auto-Impulso: primero se corrigen las tarifas.
    expect(screen.queryByTestId('boost-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('fix-panel')).toHaveTextContent('ya está publicada');
    await userEvent.click(screen.getByTestId('fix-tariff'));
    await waitFor(() => expect(consoleActions.fixTariffAction).toHaveBeenCalledWith({ initiativeId: 1 }));
  });

  it('si el negativo viene de un Auto-Impulso ya gastado, lo dice así (no como coste de pasarela) y no ofrece subir tarifas; si sin ese gasto seguiría negativo, sí (auditoría financiera del 5.2)', async () => {
    await open(popupView({ isNegativeReturnAlert: true, isProfitableSelfBoost: false, netRevenueCents: -14_000, gatewayLossCents: 0, sunkCostsCents: 15_000 }, { fix: { available: true, publishedLeftUntouched: false } }));
    expect(screen.getByTestId('popup-negative-text')).toHaveTextContent('ya ha asumido 150,00 € entre Auto-Impulso y contracargos');
    expect(screen.getByTestId('popup-negative-text')).not.toHaveTextContent('coste de pasarela');
    expect(screen.queryByTestId('fix-panel')).not.toBeInTheDocument();
  });

  it('con coste de pasarela y gasto ya asentado a la vez, dice las dos cosas y ofrece corregir las tarifas', async () => {
    await open(popupView({ isNegativeReturnAlert: true, isProfitableSelfBoost: false, netRevenueCents: -20_000, gatewayLossCents: 6_250, sunkCostsCents: 5_000 }, { fix: { available: true, publishedLeftUntouched: false } }));
    expect(screen.getByTestId('popup-negative-text')).toHaveTextContent('asume 62,50 € de coste de pasarela de pago y ya ha gastado 50,00 €');
    expect(screen.getByTestId('fix-panel')).toBeInTheDocument();
  });

  it('sin nada que corregir no hay botón, solo la explicación', async () => {
    await open(popupView({ isNegativeReturnAlert: true, isProfitableSelfBoost: false, netRevenueCents: -6_250, gatewayLossCents: 6_250 }, { fix: { available: false, publishedLeftUntouched: true } }));
    expect(screen.queryByTestId('fix-tariff')).not.toBeInTheDocument();
    expect(screen.getByTestId('fix-panel')).toHaveTextContent('su pizarra no se toca');
  });

  it.each(LOCALES)('el título, el análisis y el botón del Auto-Impulso salen en %s', async (locale) => {
    await open(popupView(), locale);
    expect(screen.getByRole('heading', { name: 'Patio cubierto' })).toBeInTheDocument();
    expect(screen.getByTestId('boost-start').textContent).toMatch(/150/);
  });
});
