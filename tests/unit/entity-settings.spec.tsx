import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalsNoticeProvider } from '@/components/panel/approvals-notice';
import { DashboardBoard } from '@/components/panel/dashboard-board';
import { EntitySettingsForm } from '@/components/panel/entity-settings-form';
import { KybSection } from '@/components/panel/kyb-section';
import { PanelNav } from '@/components/panel/panel-nav';
import {
  canEditKyb,
  entitySettingsSchema,
  kybIdentitySchema,
  kybReadiness,
  kybRetainUntil,
  requiredKybKinds,
  settingsFieldIssues,
  settingsFromColumns,
  settingsToColumns,
  type EntitySettingsInput
} from '@/core/panel/entity-settings-rules';
import type { EntitySettingsData } from '@/services/panel/entity-settings-data';
import { renderWithIntl } from '../utils/render-with-intl';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, prefetch: _prefetch, ...props }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => '/panel/colegio-sol/ajustes'
}));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const actions = { saveKybIdentityAction: vi.fn(), submitKybAction: vi.fn(), saveEntitySettingsAction: vi.fn() };
vi.mock('@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/ajustes/actions', () => ({
  saveKybIdentityAction: (...args: unknown[]) => actions.saveKybIdentityAction(...args),
  submitKybAction: (...args: unknown[]) => actions.submitKybAction(...args),
  saveEntitySettingsAction: (...args: unknown[]) => actions.saveEntitySettingsAction(...args)
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const SETTINGS: EntitySettingsInput = { donationPresetsEuros: [10, 25, 50], defaultDonationIdx: 1, minVotes: 30, maxIdeaDays: 45, sponsorTiersEuros: [100, 250, 500], phone: '', contentLocale: 'es', publicIndexing: true };

const kyb = (overrides: Partial<EntitySettingsData['kyb']> = {}): EntitySettingsData['kyb'] => {
  const base = {
    status: 'PENDING' as const,
    legalName: 'AFA CEIP Sol',
    legalForm: 'PARENTS_ASSOCIATION',
    cif: null,
    ley49: false,
    ley49Verified: false,
    submittedAt: null,
    reviewNote: null,
    required: requiredKybKinds(false),
    documents: [{ id: 4, kind: 'STATUTES' as const, uploadedAt: '2026-11-05T10:00:00.000Z', mimeType: 'application/pdf', sizeBytes: 1_258_291 }],
    replacedCount: 0,
    readiness: kybReadiness({ ley49: false, cif: null, currentKinds: ['STATUTES'] })
  };
  return { ...base, ...overrides };
};

const renderKyb = (view: EntitySettingsData['kyb'], canEdit = true) =>
  renderWithIntl(
    <ApprovalsNoticeProvider>
      <KybSection orgSlug="colegio-sol" kyb={view} canEdit={canEdit} maxBytes={10 * 1024 * 1024} legalFormLabel="AMPA / AFA" />
    </ApprovalsNoticeProvider>
  );

describe('Sprint 4.2c · reglas del KYB', () => {
  it('cuatro documentos siempre y la acreditación de la Ley 49/2002 solo si se declara; se envían con todos y el CIF', () => {
    expect(requiredKybKinds(false)).toEqual(['TAX_ID_CARD', 'STATUTES', 'REPRESENTATIVE_ID', 'ACCOUNT_OWNERSHIP']);
    expect(requiredKybKinds(true)).toContain('LEY49_ACCREDITATION');
    const all = requiredKybKinds(true);
    expect(kybReadiness({ ley49: true, cif: 'G08451296', currentKinds: all })).toEqual({ missing: [], missingTaxId: false, ready: true });
    expect(kybReadiness({ ley49: true, cif: null, currentKinds: all.slice(1) })).toEqual({ missing: ['TAX_ID_CARD'], missingTaxId: true, ready: false });
    // Un documento sobrante (Ley 49 subida antes de dejar de declararla) no estorba.
    expect(kybReadiness({ ley49: false, cif: 'G08451296', currentKinds: all }).ready).toBe(true);
  });

  it('solo se editan pendientes o devueltos; el plazo legal es de 6 años desde la fecha dada', () => {
    expect(['PENDING', 'REJECTED'].every(canEditKyb)).toBe(true);
    expect(['SUBMITTED', 'VERIFIED', 'otro'].some(canEditKyb)).toBe(false);
    expect(kybRetainUntil(new Date('2026-11-09T08:00:00Z')).toISOString()).toBe('2032-11-09T08:00:00.000Z');
  });

  it('el CIF tiene que ser de persona jurídica y válido; la razón social no admite enlaces', () => {
    expect(kybIdentitySchema.parse({ legalName: ' AFA CEIP Sol ', cif: 'g-08451296' })).toEqual({ legalName: 'AFA CEIP Sol', cif: 'G08451296' });
    expect(kybIdentitySchema.safeParse({ legalName: 'AFA CEIP Sol', cif: '12345678Z' }).success).toBe(false);
    expect(kybIdentitySchema.safeParse({ legalName: 'AFA CEIP Sol', cif: 'G08451295' }).success).toBe(false);
    expect(kybIdentitySchema.safeParse({ legalName: 'Escribid a afa@sol.example', cif: 'G08451296' }).success).toBe(false);
  });
});

describe('Sprint 4.2c · reglas de los ajustes', () => {
  it('importes enteros de menor a mayor dentro de sus límites; teléfono limpio u omitido', () => {
    expect(entitySettingsSchema.parse({ ...SETTINGS, phone: ' 93.123-45 67 ' }).phone).toBe('931234567');
    expect(settingsFieldIssues(SETTINGS)).toEqual([]);
    expect(settingsFieldIssues({ ...SETTINGS, donationPresetsEuros: [25, 10, 50] })).toEqual(['donationPresetsEuros']);
    expect(settingsFieldIssues({ ...SETTINGS, donationPresetsEuros: [0, 10, 50] })).toEqual(['donationPresetsEuros']);
    expect(settingsFieldIssues({ ...SETTINGS, donationPresetsEuros: [10, 25, 5001] })).toEqual(['donationPresetsEuros']);
    expect(settingsFieldIssues({ ...SETTINGS, sponsorTiersEuros: [40, 250, 500], minVotes: 4, maxIdeaDays: 91, phone: '12' })).toEqual(['minVotes', 'maxIdeaDays', 'sponsorTiersEuros', 'phone']);
    expect(settingsFieldIssues({ ...SETTINGS, defaultDonationIdx: 3, contentLocale: 'fr' })).toEqual(['defaultDonationIdx', 'contentLocale']);
  });

  it('guarda céntimos y enseña euros (redondeando al alza solo para mostrar un importe antiguo con céntimos)', () => {
    expect(settingsToColumns(entitySettingsSchema.parse({ ...SETTINGS, phone: '+34 600 11 22 33' }))).toEqual({
      donationPresetsCents: [1000, 2500, 5000],
      defaultDonationIdx: 1,
      minVotes: 30,
      maxIdeaDays: 45,
      sponsorTiersCents: [10000, 25000, 50000],
      phone: '+34600112233',
      contentLocale: 'es',
      publicIndexing: true
    });
    expect(settingsToColumns(entitySettingsSchema.parse(SETTINGS)).phone).toBeNull();
    const shown = settingsFromColumns({ donationPresetsCents: [1050, 2500, 5000], defaultDonationIdx: 7, minVotes: 30, maxIdeaDays: 45, sponsorTiersCents: [50000, 10000, 25000], phone: null, contentLocale: 'xx', publicIndexing: false });
    expect(shown).toMatchObject({ donationPresetsEuros: [11, 25, 50], defaultDonationIdx: 2, sponsorTiersEuros: [100, 250, 500], phone: '', contentLocale: 'es' });
  });
});

describe('Sprint 4.2c · documentos del titular en el panel', () => {
  it('pendiente: estado en texto, cada documento con su estado, qué falta para enviar y sin botón de envío', () => {
    renderKyb(kyb());
    expect(screen.getByTestId('kyb-status')).toHaveTextContent('Aún no los habéis enviado');
    expect(screen.getByTestId('kyb-STATUTES')).toHaveTextContent(/Entregado el .* · PDF, 1,2\sMB/);
    expect(screen.getByTestId('kyb-TAX_ID_CARD')).toHaveTextContent('Falta');
    expect(screen.queryByTestId('kyb-LEY49_ACCREDITATION')).toBeNull();
    expect(screen.getByRole('link', { name: 'Abrir «Estatutos, acta fundacional o escrituras» (pestaña nueva)' })).toHaveAttribute('href', '/api/panel/documentos/4?orgSlug=colegio-sol');
    expect(screen.getByRole('button', { name: /Sustituir/ })).toBeInTheDocument();
    const missing = screen.getByTestId('kyb-submit');
    expect(missing).toHaveTextContent('el CIF del titular');
    expect(missing).toHaveTextContent('Tarjeta de identificación fiscal (CIF)');
    expect(screen.queryByRole('button', { name: /Enviar los documentos/ })).toBeNull();
    // Nunca el bloque del prototipo: ni IBAN ni «cuenta bancaria».
    expect(document.body.textContent).not.toMatch(/IBAN|cuenta bancaria/i);
  });

  it('con todo listo se envía; el éxito se anuncia en el aviso de la sección y se refresca', async () => {
    const all = requiredKybKinds(false).map((kind, index) => ({ id: index + 1, kind, uploadedAt: '2026-11-05T10:00:00.000Z', mimeType: 'image/jpeg', sizeBytes: 300_000 }));
    actions.submitKybAction.mockResolvedValue({ status: 'OK' });
    renderKyb(kyb({ cif: 'G08451296', documents: all, readiness: kybReadiness({ ley49: false, cif: 'G08451296', currentKinds: all.map((item) => item.kind) }) }));
    expect(screen.getByText('Está todo: ya podéis enviarlos a revisión.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Enviar los documentos a revisión/ }));
    expect(actions.submitKybAction).toHaveBeenCalledWith('colegio-sol');
    await waitFor(() => expect(screen.getByTestId('approvals-notice')).toHaveTextContent('Documentos enviados'));
    expect(screen.getByTestId('approvals-notice')).toHaveFocus();
    expect(refresh).toHaveBeenCalled();
  });

  it('enviados o verificados: sin formularios, con lo que hay que hacer para cambiar algo; devueltos: la nota de KORUM', () => {
    const view = renderKyb(kyb({ status: 'SUBMITTED', submittedAt: '2026-11-08T10:00:00.000Z', cif: 'G08451296' }));
    expect(screen.getByTestId('kyb-status')).toHaveTextContent(/Enviados el 8 de noviembre de 2026/);
    expect(screen.getByTestId('kyb-status')).toHaveTextContent('escribid a soporte');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('G08451296')).toBeInTheDocument();
    view.unmount();
    renderKyb(kyb({ status: 'REJECTED', reviewNote: 'Falta la segunda cara del DNI.' }));
    expect(screen.getByText('Lo que hay que corregir')).toBeInTheDocument();
    expect(screen.getByText('Falta la segunda cara del DNI.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Subir|Sustituir/ }).length).toBe(4);
  });

  it('el Super-Admin lo ve en solo lectura aunque esté pendiente', () => {
    renderKyb(kyb(), false);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText(/Fichero para/)).toBeNull();
  });

  it('el CIF se comprueba antes de enviar y el error va junto al campo, con el foco', async () => {
    renderKyb(kyb());
    const cif = screen.getByLabelText('CIF del titular');
    await userEvent.type(cif, 'G08451295');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar los datos del titular' }));
    expect(await screen.findByText(/Ese CIF no es válido/)).toBeInTheDocument();
    expect(cif).toHaveAttribute('aria-invalid', 'true');
    expect(cif).toHaveFocus();
    expect(actions.saveKybIdentityAction).not.toHaveBeenCalled();
  });

  it('subir: sin fichero lo dice; un error de la ruta se dice junto al documento', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ ok: false, error: 'FILE_TYPE_NOT_ALLOWED' }) });
    vi.stubGlobal('fetch', fetchMock);
    renderKyb(kyb());
    const row = screen.getByTestId('kyb-TAX_ID_CARD');
    await userEvent.click(row.querySelector('button')!);
    expect(row).toHaveTextContent('Elegid primero el fichero.');
    await userEvent.upload(screen.getByLabelText('Fichero para «Tarjeta de identificación fiscal (CIF)»'), new File(['x'], 'cif.pdf', { type: 'application/pdf' }));
    await userEvent.click(row.querySelector('button')!);
    await waitFor(() => expect(row).toHaveTextContent('Solo se admiten PDF, JPG, PNG o WebP.'));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/panel/documentos?orgSlug=colegio-sol&kind=TAX_ID_CARD');
    expect((fetchMock.mock.calls[0]![1].body as FormData).get('file')).toBeTruthy();
  });
});

describe('Sprint 4.2c · correcciones de la revisión de experiencia', () => {
  it('una subida correcta se confirma en su fila y el foco vuelve a su título; un fichero pequeño se mide en KB', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, documentId: 9 }) }));
    renderKyb(kyb({ documents: [{ id: 4, kind: 'STATUTES', uploadedAt: '2026-11-05T10:00:00.000Z', mimeType: 'application/pdf', sizeBytes: 30_500 }] }));
    expect(screen.getByTestId('kyb-STATUTES')).toHaveTextContent(/PDF, 30\skB/);
    const row = screen.getByTestId('kyb-TAX_ID_CARD');
    await userEvent.upload(screen.getByLabelText('Fichero para «Tarjeta de identificación fiscal (CIF)»'), new File(['%PDF-1.4'], 'cif.pdf', { type: 'application/pdf' }));
    await userEvent.click(row.querySelector('button')!);
    await waitFor(() => expect(row).toHaveTextContent('«Tarjeta de identificación fiscal (CIF)»: documento recibido.'));
    expect(screen.getByRole('heading', { level: 4, name: 'Tarjeta de identificación fiscal (CIF)' })).toHaveFocus();
    expect(refresh).toHaveBeenCalled();
  });

  it('un error de subida queda asociado al campo del fichero', async () => {
    renderKyb(kyb());
    const row = screen.getByTestId('kyb-TAX_ID_CARD');
    await userEvent.click(row.querySelector('button')!);
    const input = screen.getByLabelText('Fichero para «Tarjeta de identificación fiscal (CIF)»');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/Elegid primero el fichero/);
  });

  it('el cuadro de mandos vacío dice que los documentos están en revisión y no manda a subirlos', () => {
    const view = renderWithIntl(<DashboardBoard orgSlug="colegio-sol" initiatives={[]} activeSponsors={0} readySigners={2} kybStatus="SUBMITTED" />);
    expect(screen.getByText('Enviados: están en revisión y os avisaremos por email.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ir a los documentos' })).toBeNull();
    view.unmount();
    renderWithIntl(<DashboardBoard orgSlug="colegio-sol" initiatives={[]} activeSponsors={0} readySigners={2} kybStatus="REJECTED" />);
    expect(screen.getByRole('link', { name: 'Ir a los documentos' })).toHaveAttribute('href', '/panel/colegio-sol/ajustes#documentos');
  });
});

describe('Sprint 4.2c · ajustes generales en el panel', () => {
  it('avisa de los importes desordenados junto al grupo y lleva el foco al primero; no llama al servidor', async () => {
    renderWithIntl(
      <ApprovalsNoticeProvider>
        <EntitySettingsForm orgSlug="colegio-sol" initial={SETTINGS} canEdit />
      </ApprovalsNoticeProvider>
    );
    const first = screen.getByLabelText('Botón 1 (€)');
    await userEvent.clear(first);
    await userEvent.type(first, '60');
    await userEvent.click(screen.getByRole('button', { name: /Guardar los ajustes/ }));
    expect(await screen.findByText(/Tres importes de 1 a 5000 €/)).toBeInTheDocument();
    expect(first).toHaveFocus();
    expect(actions.saveEntitySettingsAction).not.toHaveBeenCalled();
  });

  it('guarda y anuncia cuántas ideas pasan a la firma de la entidad', async () => {
    actions.saveEntitySettingsAction.mockResolvedValue({ status: 'OK', ideasToDoubleCheck: 2 });
    renderWithIntl(
      <ApprovalsNoticeProvider>
        <EntitySettingsForm orgSlug="colegio-sol" initial={SETTINGS} canEdit />
      </ApprovalsNoticeProvider>
    );
    const minVotes = screen.getByLabelText(/Firmas mínimas/);
    await userEvent.clear(minVotes);
    await userEvent.type(minVotes, '20');
    await userEvent.type(screen.getByLabelText('Teléfono de la entidad'), '93 123 45 67');
    await userEvent.click(screen.getByLabelText(/Mostrar el portal en buscadores/));
    await userEvent.click(screen.getByRole('button', { name: /Guardar los ajustes/ }));
    await waitFor(() => expect(screen.getByTestId('approvals-notice')).toHaveTextContent('Ajustes guardados: 2 ideas pasan a la firma de la entidad al alcanzar el nuevo mínimo de firmas.'));
    expect(actions.saveEntitySettingsAction).toHaveBeenCalledWith('colegio-sol', { ...SETTINGS, minVotes: 20, phone: '93 123 45 67', publicIndexing: false });
  });

  it('en solo lectura no hay botón de guardar y los campos están desactivados', () => {
    renderWithIntl(<EntitySettingsForm orgSlug="colegio-sol" initial={SETTINGS} canEdit={false} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByLabelText('Teléfono de la entidad')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Importe preseleccionado')).toBeDisabled();
  });

  it('la navegación del panel lleva a «Ajustes» y la marca como actual', () => {
    renderWithIntl(<PanelNav orgSlug="colegio-sol" />);
    expect(screen.getByRole('link', { name: 'Ajustes' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Ajustes' })).toHaveAttribute('href', '/panel/colegio-sol/ajustes');
  });
});
