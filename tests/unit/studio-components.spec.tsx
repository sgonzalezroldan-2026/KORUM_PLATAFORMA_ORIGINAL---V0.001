import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PosterConfigurator } from '@/components/panel/poster-configurator';
import { StudioWorkbench, type StudioWorkbenchProps } from '@/components/panel/studio-workbench';
import { TemplateArt } from '@/components/panel/template-illustration';
import { CAMPAIGN_TEMPLATES } from '@/core/studio/campaign-templates';
import type { StudioContext } from '@/core/studio/studio-board';
import { blankStudioDraft, TICKETING_CATEGORY, type StudioDraft } from '@/core/studio/studio-draft';
import { renderWithIntl } from '../utils/render-with-intl';

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  save: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn()
}));

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, prefetch: _prefetch, ...props }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => '/panel/cervantes/estudio',
  useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace })
}));
vi.mock('@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/estudio/actions', () => ({
  publishStudioAction: mocks.publish,
  saveStudioAction: mocks.save
}));

/** `Intl` separa el importe del símbolo con un espacio duro; las pruebas comparan con espacios normales. */
const plain = (text: string | null | undefined) => (text ?? '').replace(/[  ]/g, ' ');

const CONTEXT: StudioContext = {
  vertical: 'SCHOOL',
  bracket: { mode: 'FLAT', t1MaxCents: 500_000, t2MaxCents: 1_500_000, ratesBps: { t1: 500, t2: 400, t3: 300 } },
  gateway: { pctBps: 100, fixedCents: 9 },
  donationTicketCents: 2500,
  exemptRemainingCents: 100_000,
  medalGrantAvailableCents: 0,
  medalRank: 0,
  maint: { active: false, perInitCents: 4900, annualCapCents: 14_700, paidCents: 0 },
  ticketFee: { fixedCents: 45, pctBps: 200 },
  maxCampaignDays: 60,
  categories: [
    { name: 'Infraestructura y Confort', icon: '🌡️', rule: 'BRACKETS' },
    { name: 'Comunidad y Viajes', icon: '🎒', rule: 'EXEMPT' },
    { name: TICKETING_CATEGORY, icon: '🎟️', rule: 'EXEMPT' }
  ],
  kybVerified: true
};

const REWARDS = { cinema: 'Cine', games: 'Juegos', noHomework: 'Sin deberes' } as const;

function props(draft: StudioDraft, overrides: Partial<StudioWorkbenchProps> = {}): StudioWorkbenchProps {
  return { orgSlug: 'cervantes', context: CONTEXT, initialDraft: draft, lock: 'NONE', stored: null, rewardPresets: REWARDS, nowIso: '2026-11-10T10:00:00Z', today: '2026-11-10', maxCloseOn: '2027-01-08', justPublished: false, ...overrides };
}

const budget = (overrides: Partial<StudioDraft> = {}): StudioDraft => ({ ...blankStudioDraft('BUDGET', 'SCHOOL', '2026-12-10'), initiativeId: 7, title: 'Aulas frescas', description: 'Ventilación', category: 'Infraestructura y Confort', costMatCents: 380_000, costInstCents: 130_000, rewardText: REWARDS.cinema, ...overrides });
const raffle = (overrides: Partial<StudioDraft> = {}): StudioDraft => ({ ...blankStudioDraft('TICKETING', 'SCHOOL', '2026-12-10'), initiativeId: 8, title: 'Rifa', description: 'Papeletas', ticketSubtype: 'RAFFLE', ticketPriceCents: 200, ticketMax: 500, rewardText: REWARDS.cinema, ...overrides });

describe('QA-S01 · Estudio de edición', () => {
  it('la pizarra enseña la meta cuadrada y el mantenimiento a 0 solo como «0,00 €», sin «desactivado»', () => {
    renderWithIntl(<StudioWorkbench {...props(budget())} />);
    const lines = screen.getByTestId('studio-tco-lines');
    const maintenance = within(lines).getByText(/Cargo de mantenimiento de la plataforma/).closest('div');
    expect(plain(maintenance?.textContent)).toContain('0,00 €');
    expect(document.body.textContent).not.toMatch(/desactivad/i);
    expect(plain(screen.getByTestId('studio-goal').textContent)).toBe('5.874,00 €');
    expect(plain(screen.getByTestId('studio-gateway-formula').textContent)).toContain('Suma cuadrada: 5.610,00 € + 184,40 € + 0,00 € + 79,60 € = 5.874,00 €');
  });

  it('cambiar el presupuesto recalcula la pizarra en vivo', async () => {
    const user = userEvent.setup();
    renderWithIntl(<StudioWorkbench {...props(budget())} />);
    const field = screen.getByLabelText('Presupuesto del proveedor (€)');
    await user.clear(field);
    await user.type(field, '1000');
    // 1.000 + 1.300 de instalación = 2.300 € + 10 % = 2.530 €; 1.000 € exentos; resto 1.530 € al 5 % = 76,50 €.
    expect(plain(screen.getByTestId('studio-tco-lines').textContent)).toContain('76,50 €');
    expect(plain(screen.getByTestId('studio-goal').textContent)).toMatch(/^2\.6\d\d,00 €$/);
  });

  it('un importe mal escrito se avisa junto al campo y conserva el valor anterior', async () => {
    const user = userEvent.setup();
    renderWithIntl(<StudioWorkbench {...props(budget())} />);
    const field = screen.getByLabelText('Presupuesto del proveedor (€)');
    await user.clear(field);
    await user.type(field, 'doce');
    // Mientras se teclea no se grita («12,» es un importe a medias): el aviso sale al salir del campo.
    expect(screen.queryByText('Escribid un importe válido, por ejemplo 1.250,50')).not.toBeInTheDocument();
    await user.tab();
    expect(await screen.findByText('Escribid un importe válido, por ejemplo 1.250,50')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('el candado semántico avisa en vivo al escribir «ventiladores» en una categoría al 0 %', async () => {
    const user = userEvent.setup();
    renderWithIntl(<StudioWorkbench {...props(budget({ category: 'Comunidad y Viajes', title: 'Excursión', description: 'Autocar' }))} />);
    expect(screen.queryByTestId('studio-lock-alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('studio-badge')).toHaveTextContent('Categoría al 0 % de comisión');
    const title = screen.getByLabelText('Título de la iniciativa, evento o rifa');
    await user.clear(title);
    await user.type(title, 'Ventiladores para el comedor');
    const alert = await screen.findByTestId('studio-lock-alert');
    expect(alert).toHaveTextContent('ventiladores');
    expect(screen.getByTestId('studio-badge')).not.toHaveTextContent('0 %');
  });

  it('una rifa muestra el aviso normativo y no se puede publicar sin premios ni confirmación', async () => {
    const user = userEvent.setup();
    renderWithIntl(<StudioWorkbench {...props(raffle())} />);
    expect(screen.getByTestId('raffle-notice')).toHaveTextContent('competencia de cada comunidad autónoma');
    const publish = screen.getByTestId('studio-publish');
    expect(publish).toBeDisabled();
    expect(screen.getByTestId('studio-blockers')).toHaveTextContent('Indicad cuántos premios se sortean');
    expect(screen.getByTestId('studio-blockers')).toHaveTextContent('Confirmad que la rifa cumple la normativa');

    await user.type(screen.getByLabelText('Premios que se sortean'), '3');
    expect(publish).toBeDisabled();
    await user.click(screen.getByLabelText('Confirmamos que la rifa cumple la normativa de nuestra comunidad autónoma'));
    expect(publish).toBeEnabled();
    expect(screen.queryByTestId('studio-blockers')).not.toBeInTheDocument();
  });

  it('publicar pide confirmación y manda al servidor la meta que se aceptó, no una cifra calculada por el navegador', async () => {
    const user = userEvent.setup();
    mocks.publish.mockResolvedValue({ status: 'PUBLISHED', initiativeId: 7 });
    renderWithIntl(<StudioWorkbench {...props(budget())} />);
    await user.click(screen.getByTestId('studio-publish'));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('5.874,00');
    expect(mocks.publish).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('studio-confirm-publish'));
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    const [slug, payload] = mocks.publish.mock.calls[0]!;
    expect(slug).toBe('cervantes');
    expect(payload).toMatchObject({ expectedGoalCents: 587_400, draft: { initiativeId: 7, costMatCents: 380_000 } });
    expect(Object.keys(payload.draft)).not.toContain('goalCents');
    expect(mocks.replace).toHaveBeenCalledWith('/panel/cervantes/estudio?iniciativa=7&publicada=1');
  });

  it('si los cupos cambiaron mientras tanto, el error se explica y la pizarra se refresca', async () => {
    const user = userEvent.setup();
    mocks.publish.mockResolvedValue({ status: 'ERROR', reason: 'STALE_BOARD', detail: [], initiativeId: 7 });
    renderWithIntl(<StudioWorkbench {...props(budget())} />);
    await user.click(screen.getByTestId('studio-publish'));
    await user.click(screen.getByTestId('studio-confirm-publish'));
    expect(await screen.findByRole('alert')).toHaveTextContent('la meta ya no es la que visteis');
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('sin los documentos del titular verificados no se publica y se enlaza a los documentos', () => {
    renderWithIntl(<StudioWorkbench {...props(budget(), { context: { ...CONTEXT, kybVerified: false } })} />);
    expect(screen.getByTestId('studio-publish')).toBeDisabled();
    const link = within(screen.getByTestId('studio-blockers')).getByRole('link', { name: 'Ir a los documentos' });
    expect(link).toHaveAttribute('href', '/panel/cervantes/ajustes#documentos');
  });

  it('con la campaña ya recaudando solo se pueden tocar la descripción y el reto; el presupuesto queda bloqueado', () => {
    const stored = { status: 'FUNDRAISING', walletEscrowId: 'WLT-ESC-AAAAAA', raisedCents: 1000, goalCents: 587_400, maintFeeCents: 0, defaultExemptAppliedCents: 100_000, medalExemptAppliedCents: 0, bracketRateAppliedBps: 400, bracketFeeCents: 18_440, gatewayFeeCents: 7960 };
    renderWithIntl(<StudioWorkbench {...props(budget(), { lock: 'SOFT', stored })} />);
    expect(screen.getByLabelText('Presupuesto del proveedor (€)')).toBeDisabled();
    expect(screen.getByLabelText('Título de la iniciativa, evento o rifa')).toBeDisabled();
    expect(screen.getByLabelText('Descripción')).toBeEnabled();
    expect(screen.queryByTestId('studio-publish')).not.toBeInTheDocument();
    expect(screen.getByTestId('studio-save')).toBeInTheDocument();
    expect(screen.getByTestId('studio-poster-link')).toHaveAttribute('href', '/panel/cervantes/estudio/7/cartel');
    expect(plain(screen.getByTestId('studio-goal').textContent)).toBe('5.874,00 €');
  });

  it('en catalán y en inglés los textos salen de sus catálogos', () => {
    const { unmount } = renderWithIntl(<StudioWorkbench {...props(budget())} />, 'ca');
    expect(screen.getByText('Auditoria interna de l’entitat')).toBeInTheDocument();
    unmount();
    renderWithIntl(<StudioWorkbench {...props(budget())} />, 'en');
    expect(screen.getByText('The organisation’s internal audit')).toBeInTheDocument();
    expect(plain(screen.getByTestId('studio-goal').textContent)).toBe('€5,874.00');
  });
});

describe('QA-S01 · cartel A4 y plantillas', () => {
  it('el cartel enseña el título y el mensaje que escribe la entidad, el QR real y la dirección impresa', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <PosterConfigurator
        logoSrc="/api/files/public/abc"
        walletId="WLT-ESC-AAAAAA"
        qrSvg='<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'
        qrPng="data:image/png;base64,AAAA"
        displayUrl="korum.es/cervantes/iniciativas/7"
        defaultTitle="¡Súmate!"
        defaultMessage="Escanea el código"
        contentLang="es"
        sheet={{ label: 'Cartel A4 para imprimir', platform: 'KORUM', payments: 'Pagos con PAYCOMET', withKorum: 'CEIP Cervantes × KORUM', qrLabel: 'Código QR', guarantee: 'Hucha WLT-ESC-AAAAAA' }}
      />
    );
    expect(screen.getByTestId('poster-title')).toHaveTextContent('¡Súmate!');
    const title = screen.getByLabelText('Título del cartel');
    await user.clear(title);
    await user.type(title, 'Mejoremos el patio');
    expect(screen.getByTestId('poster-title')).toHaveTextContent('Mejoremos el patio');
    expect(screen.getByTestId('poster-url')).toHaveTextContent('korum.es/cervantes/iniciativas/7');
    expect(screen.getByTestId('poster-qr').querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('poster-logo')).toHaveAttribute('src', '/api/files/public/abc');
    expect(screen.getByTestId('poster-download-qr')).toHaveAttribute('href', 'data:image/png;base64,AAAA');
    expect(screen.getByTestId('poster-sheet')).toHaveAttribute('lang', 'es');
    // La hoja no menciona «Escrow», un banco ni importes (Regla 03 §4).
    expect(screen.getByTestId('poster-sheet').textContent).not.toMatch(/escrow|banco/i);
  });

  it('sin logotipo, el cartel sale sin icono', () => {
    renderWithIntl(<PosterConfigurator logoSrc={null} walletId="W" qrSvg="<svg></svg>" qrPng="data:" displayUrl="x" defaultTitle="T" defaultMessage="M" contentLang="es" sheet={{ label: 'l', platform: 'p', payments: 'pp', withKorum: 'w', qrLabel: 'q', guarantee: 'g' }} />);
    expect(screen.queryByTestId('poster-logo')).not.toBeInTheDocument();
  });

  it('cada plantilla tiene su ilustración SVG decorativa', () => {
    for (const template of CAMPAIGN_TEMPLATES) {
      const { container, unmount } = renderWithIntl(<TemplateArt kind={template.illustration} />);
      const svg = container.querySelector('svg');
      expect(svg, template.key).not.toBeNull();
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      unmount();
    }
  });
});
