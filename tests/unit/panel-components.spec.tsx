import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DashboardBoard } from '@/components/panel/dashboard-board';
import { MedalKit } from '@/components/panel/medal-kit';
import { Model182Card } from '@/components/panel/model182-card';
import { PanelManagementHeader } from '@/components/panel/panel-management-header';
import { ToastProvider } from '@/components/ui/toast-provider';
import { medalLevels } from '@/core/medals/medal-kit';
import type { DashboardInitiative } from '@/core/panel/dashboard';
import { renderWithIntl } from '../utils/render-with-intl';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, prefetch: _prefetch, ...props }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => '/panel/cervantes'
}));
// El componente de servidor pide sus textos con `getTranslations`: aquí se resuelven con los catálogos reales, sin la petición de Next.
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('../../messages/es.json')).default;
  return { getTranslations: async ({ locale, namespace }: { locale: string; namespace: string }) => createTranslator({ locale, messages, namespace: namespace as never }) };
});
vi.mock('@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/actions', () => ({ resendInvitationAction: vi.fn(async () => 'SENT') }));

beforeAll(() => {
  // jsdom no implementa el diálogo modal: basta con marcarlo abierto para comprobar el contenido.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(() => vi.unstubAllGlobals());

/** `Intl` separa el importe del símbolo con un espacio duro; las pruebas comparan con espacios normales. */
const plain = (text: string | null | undefined) => (text ?? '').replace(/[  ]/g, ' ');

const item = (overrides: Partial<DashboardInitiative> = {}): DashboardInitiative => ({
  id: 1,
  walletEscrowId: 'WLT-ESC-AAAAAA',
  title: 'Ventiladores para las aulas',
  category: 'Infraestructura',
  academicYear: '2026-2027',
  format: 'BUDGET',
  status: 'FUNDRAISING',
  stepIndex: 4,
  raisedCents: 150_000,
  goalCents: 400_000,
  closesAt: '2026-12-31T23:00:00.000Z',
  totalContributions: 12,
  ...overrides
});

const board = (initiatives: DashboardInitiative[], extra: Partial<Parameters<typeof DashboardBoard>[0]> = {}) =>
  renderWithIntl(<DashboardBoard orgSlug="cervantes" initiatives={initiatives} activeSponsors={3} readySigners={2} kybStatus="VERIFIED" {...extra} />);

describe('cuadro de mandos (QA-S02)', () => {
  it('los filtros están ocultos al cargar; se abren con «Filtrar» y el contador cuenta los activos', async () => {
    board([item(), item({ id: 2, title: 'Pista cubierta', status: 'CLOSED', stepIndex: 5, academicYear: '2025-2026' })]);
    const toggle = screen.getByRole('button', { name: /Filtrar/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByLabelText('Estado')).not.toBeVisible();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'CLOSED');
    expect(screen.getByRole('button', { name: /Filtrar 1 filtro activo/ })).toBeInTheDocument();
    expect(screen.queryByText('Ventiladores para las aulas')).toBeNull();
    expect(screen.getByText('Pista cubierta')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 iniciativa');
    await userEvent.click(screen.getByRole('button', { name: 'Restablecer' }));
    expect(screen.getByText('Ventiladores para las aulas')).toBeInTheDocument();
    expect(screen.queryByText(/filtro activo/)).toBeNull();
  });

  it('indicadores con importes en céntimos, comercios activos y tarjeta con hucha, línea de 6 estados y ficha pública', () => {
    board([item(), item({ id: 2, title: 'Pista cubierta', status: 'GOAL_REACHED', stepIndex: 5, raisedCents: 50_000 })]);
    const kpis = screen.getAllByRole('definition').map((node) => plain(node.textContent));
    expect(kpis).toEqual(['2', '1', '1', '2.000,00 €', '3']);
    const first = screen.getByRole('heading', { level: 3, name: 'Ventiladores para las aulas' }).closest('li')!;
    expect(within(first).getByText('Hucha WLT-ESC-AAAAAA')).toBeInTheDocument();
    expect(within(first).getByText('1.500,00 € de 4.000,00 €')).toBeInTheDocument();
    expect(within(first).getByRole('progressbar', { name: 'Avance de «Ventiladores para las aulas»: 37 %' })).toBeInTheDocument();
    expect(within(first).getByText('💛 12 aportaciones')).toBeInTheDocument();
    const steps = within(first).getAllByRole('listitem').filter((node) => /^\d\./.test(node.textContent ?? ''));
    expect(steps).toHaveLength(6);
    expect(steps[4]).toHaveAttribute('aria-current', 'step');
    expect(steps[4]).toHaveTextContent('5. Recaudando (fase actual)');
    expect(steps[0]).toHaveTextContent('1. Moderación (hecha)');
    expect(steps[5]).toHaveTextContent('6. Logro (pendiente)');
    expect(within(first).getByRole('link', { name: /Ver la ficha pública de «Ventiladores para las aulas»/ })).toHaveAttribute('href', '/cervantes/iniciativas/1');
  });

  it('cada fase explica qué es con un tooltip que aparece al enfocarla con el teclado', async () => {
    board([item()]);
    const phase = screen.getByText('2. Firmas');
    act(() => (phase.closest('span[tabindex]') as HTMLElement).focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Recogida de firmas de la comunidad, con auditoría antifraude.');
  });

  it('una iniciativa sin ficha pública (presupuestación) no ofrece el enlace; una taquilla se rotula como tal', () => {
    board([item({ id: 3, title: 'Cine de verano', status: 'BUDGETING', stepIndex: 3, format: 'TICKETING' })]);
    expect(screen.queryByRole('link', { name: /ficha pública/ })).toBeNull();
    expect(screen.getByText(/Taquilla o rifa/)).toBeInTheDocument();
  });

  it('si los filtros no dejan nada, lo dice y ofrece restablecer', async () => {
    board([item()]);
    await userEvent.click(screen.getByRole('button', { name: /Filtrar/ }));
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'REFUNDED');
    expect(screen.getByRole('heading', { name: 'Ninguna iniciativa coincide' })).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Restablecer' });
    await userEvent.click(buttons[buttons.length - 1]!);
    expect(screen.getByText('Ventiladores para las aulas')).toBeInTheDocument();
  });

  it('sin iniciativas, estado vacío guiado con lo que falta y sin filtros ni indicadores', () => {
    board([], { readySigners: 1, kybStatus: 'PENDING' });
    expect(screen.getByRole('heading', { name: 'Vuestra primera campaña empieza aquí' })).toBeInTheDocument();
    const steps = within(screen.getByRole('list', { name: 'Pasos hasta la primera campaña' })).getAllByRole('listitem');
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveTextContent('Falta que la otra persona firmante active su cuenta');
    expect(steps[1]).toHaveTextContent('Faltan los documentos del titular');
    expect(steps[2]).toHaveTextContent('Estudio de edición llegará muy pronto');
    expect(screen.queryByRole('button', { name: /Filtrar/ })).toBeNull();
  });

  it('con las firmas y los documentos listos, los dos primeros pasos salen hechos', () => {
    board([], { readySigners: 2, kybStatus: 'VERIFIED' });
    const steps = within(screen.getByRole('list', { name: 'Pasos hasta la primera campaña' })).getAllByRole('listitem');
    expect(steps[0]).toHaveTextContent('Las dos personas firmantes están listas.');
    expect(steps[1]).toHaveTextContent('Verificados: podéis publicar campañas con cobro.');
  });
});

const TIERS = [
  { key: 'bronze', name: 'Bronce', icon: '🥉', rank: 1, campaignsRequired: 1, grantCents: 50_000 },
  { key: 'silver', name: 'Plata', icon: '🥈', rank: 2, campaignsRequired: 2, grantCents: 100_000 },
  { key: 'gold', name: 'Oro', icon: '🥇', rank: 3, campaignsRequired: 3, grantCents: 200_000 }
];

const kit = (rank: number, completed: number, vertical: 'SCHOOL' | 'SPORTS_CLUB' | 'CULTURAL' = 'SCHOOL') =>
  renderWithIntl(
    <ToastProvider>
      <MedalKit orgSlug="cervantes" entityName="CEIP Cervantes" vertical={vertical} period="2026-2027" levels={medalLevels(TIERS, rank, completed)} />
    </ToastProvider>
  );

describe('kit de medallas (QA-S05)', () => {
  it('cada nivel explica su beca y su estado en positivo; solo los conseguidos tienen kit', () => {
    kit(1, 1);
    const [bronze, silver, gold] = screen.getAllByRole('listitem');
    expect(bronze).toHaveTextContent('Medalla Bronce');
    expect(bronze).toHaveTextContent('+500,00 € exentos de comisión');
    expect(bronze).toHaveTextContent('Conseguida: ya tenéis su kit.');
    expect(within(bronze!).getByRole('button', { name: /Sello y texto para redes/ })).toBeInTheDocument();
    expect(silver).toHaveTextContent('Siguiente medalla: os falta 1 campaña conseguida este curso.');
    expect(within(silver!).queryByRole('button')).toBeNull();
    expect(gold).toHaveTextContent('Se consigue con 3 campañas conseguidas en el curso.');
    expect(within(gold!).queryByRole('button')).toBeNull();
  });

  it('el diálogo trae el informe, el sello, el texto editable con las etiquetas y el enlace de WhatsApp', async () => {
    kit(2, 2);
    const silver = screen.getAllByRole('listitem')[1]!;
    await userEvent.click(within(silver).getByRole('button', { name: /Sello y texto para redes/ }));
    const dialog = screen.getByRole('dialog', { name: 'Kit oficial · Medalla Plata' });
    expect(within(dialog).getByText('Sello Comunidad Impulsora KORUM · Nivel Plata (2026-2027)')).toBeInTheDocument();
    const report = within(dialog).getByRole('link', { name: /Descargar el informe \(PDF\)/ });
    expect(new URL(report.getAttribute('href')!, 'http://x').searchParams.get('tipo')).toBe('informe');
    expect(new URL(report.getAttribute('href')!, 'http://x').searchParams.get('nivel')).toBe('silver');
    expect(new URL(report.getAttribute('href')!, 'http://x').searchParams.get('orgSlug')).toBe('cervantes');
    const seal = within(dialog).getByRole('link', { name: /Descargar el sello para la web \(SVG\)/ });
    expect(new URL(seal.getAttribute('href')!, 'http://x').searchParams.get('tipo')).toBe('sello');
    const text = within(dialog).getByRole('textbox', { name: /Texto para las redes de la entidad/ }) as HTMLTextAreaElement;
    expect(text.value).toContain('CEIP Cervantes');
    expect(text.value).toContain('nivel Plata 🥈');
    expect(text.value).toContain('#ComunidadKORUM #CEIPCervantes');
    expect(text.value).toContain('nuestras familias');
    await userEvent.clear(text);
    await userEvent.type(text, 'Orgullo');
    const share = within(dialog).getByRole('link', { name: /Compartir por WhatsApp/ });
    expect(new URL(share.getAttribute('href')!).searchParams.get('text')).toBe('Orgullo');
    expect(share).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('los nombres de las medallas salen en el idioma de la interfaz, no en el de la consola', async () => {
    renderWithIntl(
      <ToastProvider>
        <MedalKit orgSlug="cervantes" entityName="CEIP Cervantes" vertical="SCHOOL" period="2026-2027" levels={medalLevels(TIERS, 2, 2)} />
      </ToastProvider>,
      'en'
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Bronze medal');
    expect(items[1]).toHaveTextContent('Silver medal');
    expect(items[2]).toHaveTextContent('Gold medal');
    expect(screen.queryByText(/Plata|Oro|Bronce/)).toBeNull();
    await userEvent.click(within(items[1]!).getByRole('button'));
    const dialog = screen.getByRole('dialog', { name: 'Silver medal · official kit' });
    expect((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value).toContain('Silver level');
    expect(within(dialog).getByRole('link', { name: /Share on WhatsApp \(opens in a new tab\)/ })).toBeInTheDocument();
  });

  it('copiar escribe en el portapapeles y lo confirma; el texto del club habla de socios', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    kit(1, 1, 'SPORTS_CLUB');
    await userEvent.click(screen.getByRole('button', { name: /Sello y texto para redes/ }));
    await userEvent.click(screen.getByRole('button', { name: /Copiar el texto/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect((writeText.mock.calls[0] as unknown as [string])[0]).toContain('socios, familias y comercios vecinos');
    expect(await screen.findByText('Texto copiado')).toBeInTheDocument();
  });
});

const signers = [
  { userId: 'u1', name: 'Carla Puig', role: 'DIRECTOR' as const, roleLabel: 'Dirección del centro', status: 'ACTIVE' as const },
  { userId: 'u2', name: 'Marta Soler', role: 'COSIGNER' as const, roleLabel: 'Presidencia del AFA', status: 'INVITED' as const }
];
const headerOrg = {
  slug: 'cervantes',
  walletId: 'WLT-ESC-AAAAAA',
  kybStatus: 'VERIFIED',
  exemptLimitCents: 100_000,
  exemptRemainingCents: 40_000,
  medalGrantAvailableCents: 100_000,
  medalGrantUsedInTitle: null,
  maintActive: false,
  maintPaidCents: 0,
  maintAnnualCapCents: 0,
  quotaPeriod: '2026-2027'
};

describe('cabecera de gestión', () => {
  it('muestra la hucha, el estado de los documentos, los cupos y las dos firmas con su cargo', async () => {
    const header = await PanelManagementHeader({ locale: 'es', organization: headerOrg, signers, isDirector: true });
    renderWithIntl(header);
    expect(screen.getByText('WLT-ESC-AAAAAA')).toBeInTheDocument();
    expect(screen.getByText('Titular verificado')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Cupos del curso 2026-2027' })).toBeInTheDocument();
    expect(screen.getByText(/Sin comisión de plataforma/)).toHaveTextContent('400,00 € de 1.000,00 € disponibles');
    expect(screen.getByText(/Beca de medalla/)).toHaveTextContent('+1.000,00 € exentos de comisión');
    // Mantenimiento desactivado: solo el importe en cero, nunca «(Desactivado)».
    expect(screen.getByText(/Mantenimiento de la plataforma/)).toHaveTextContent('Mantenimiento de la plataforma: 0,00 €');
    expect(screen.queryByText(/Desactivado/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Doble firma (1 de 2 listas)' })).toBeInTheDocument();
    expect(screen.getByText('Dirección del centro · Carla Puig')).toBeInTheDocument();
    expect(screen.getByText('Presidencia del AFA · Marta Soler')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reenviar la invitación' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cuadro de mandos' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Logros' })).not.toHaveAttribute('aria-current');
  });

  it('con la beca ya usada la nombra; con mantenimiento activo enseña lo pagado y el tope; la segunda firma no ve «reenviar»', async () => {
    const header = await PanelManagementHeader({
      locale: 'es',
      organization: { ...headerOrg, medalGrantAvailableCents: 0, medalGrantUsedInTitle: 'Climatización', maintActive: true, maintPaidCents: 5_000, maintAnnualCapCents: 20_000 },
      signers,
      isDirector: false
    });
    renderWithIntl(header);
    expect(screen.getByText(/Beca de medalla/)).toHaveTextContent('aplicada en «Climatización»');
    expect(screen.getByText(/Mantenimiento de la plataforma/)).toHaveTextContent('50,00 € de 200,00 € este curso');
    expect(screen.queryByRole('button', { name: 'Reenviar la invitación' })).toBeNull();
  });
});

describe('Modelo 182 (QA-REG02)', () => {
  it('sin la Ley 49/2002 verificada no hay descarga: explica qué reciben las familias', () => {
    renderWithIntl(<Model182Card orgSlug="cervantes" verified={false} years={[2026, 2025]} defaultYear={2025} defaultPhone="" />);
    expect(screen.getByText(/justificante nominativo de aportación, sin efectos fiscales/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Descargar el fichero/ })).toBeNull();
  });

  it('con un teléfono que no son 9 cifras no llama al servidor, marca el campo y lleva el foco', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderWithIntl(<Model182Card orgSlug="cervantes" verified years={[2026, 2025]} defaultYear={2025} defaultPhone="" />);
    await userEvent.click(screen.getByRole('button', { name: /Descargar el fichero/ }));
    const phone = screen.getByLabelText('Teléfono de contacto');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(phone).toHaveAttribute('aria-invalid', 'true');
    expect(phone).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent('Escribid un teléfono de 9 cifras.');
  });

  it('pide el ejercicio elegido, descarga el fichero y cuenta lo que entró y lo que quedó fuera', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('registro', {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="modelo182-2025-cervantes.txt"', 'X-Korum-Donors': '12', 'X-Korum-Total-Cents': '345600', 'X-Korum-Excluded': '2', 'X-Korum-Excluded-Cents': '5000', 'X-Korum-Unresolved': '1', 'X-Korum-Unresolved-Cents': '2500' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
    renderWithIntl(<Model182Card orgSlug="cervantes" verified years={[2026, 2025]} defaultYear={2025} defaultPhone="934128890" />);
    await userEvent.selectOptions(screen.getByLabelText('Ejercicio'), '2026');
    await userEvent.click(screen.getByRole('button', { name: /Descargar el fichero/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/panel/modelo-182');
    expect(JSON.parse(init.body as string)).toEqual({ orgSlug: 'cervantes', fiscalYear: 2026, contactPhone: '934128890' });
    expect(await screen.findByText(/Fichero del ejercicio 2026 descargado: 12 personas declaradas por un total de 3.456,00 €/)).toBeInTheDocument();
    expect(screen.getByText(/Quedan fuera 2 aportaciones \(50,00 €\)/)).toBeInTheDocument();
    expect(screen.getByText(/Incluye 1 donativo \(25,00 €\) de campañas que aún no se han resuelto/)).toBeInTheDocument();
  });

  it('cuenta aparte lo que no entra por estar su campaña devolviéndose o cancelada', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="m.txt"', 'X-Korum-Donors': '1', 'X-Korum-Total-Cents': '1000', 'X-Korum-Returned': '3', 'X-Korum-Returned-Cents': '7500' } })));
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
    renderWithIntl(<Model182Card orgSlug="cervantes" verified years={[2025]} defaultYear={2025} defaultPhone="934128890" />);
    await userEvent.click(screen.getByRole('button', { name: /Descargar el fichero/ }));
    expect(await screen.findByText(/Quedan fuera 3 donativos \(75,00 €\) de campañas que se están devolviendo o se cancelaron/)).toBeInTheDocument();
  });

  it('si el servidor dice que la Ley 49/2002 no está verificada lo anuncia', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'LEY49_NOT_VERIFIED' }), { status: 409 })));
    renderWithIntl(<Model182Card orgSlug="cervantes" verified years={[2025]} defaultYear={2025} defaultPhone="934128890" />);
    await userEvent.click(screen.getByRole('button', { name: /Descargar el fichero/ }));
    expect(await screen.findByText('La Ley 49/2002 de la entidad aún no está verificada.')).toBeInTheDocument();
  });
});
