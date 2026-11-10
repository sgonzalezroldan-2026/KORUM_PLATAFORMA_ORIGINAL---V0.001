import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalsNoticeProvider } from '@/components/panel/approvals-notice';
import { PanelNav } from '@/components/panel/panel-nav';
import { SponsorModerationCard } from '@/components/panel/sponsor-moderation-card';
import { badgeExpiryFrom, needsDecision, rejectSponsorSchema, sortForModeration, SPONSOR_REJECTION_REASON_MIN } from '@/core/sponsors/sponsor-moderation-rules';
import { recordOfInvoice } from '@/services/invoicing/invoice.service';
import { computeVerifactuHash, formatCents } from '@/services/invoicing/verifactu-record';
import type { ModerationSponsorView } from '@/services/panel/sponsor-moderation-data';
import { renderWithIntl } from '../utils/render-with-intl';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, prefetch: _prefetch, ...props }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => '/panel/colegio-sol/aprobaciones'
}));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const actions = { approveSponsorAction: vi.fn(), rejectSponsorAction: vi.fn(), assignPooledSponsorAction: vi.fn(), sendSponsorRenewalLinkAction: vi.fn() };
vi.mock('@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/aprobaciones/actions', () => ({
  approveSponsorAction: (...args: unknown[]) => actions.approveSponsorAction(...args),
  rejectSponsorAction: (...args: unknown[]) => actions.rejectSponsorAction(...args),
  assignPooledSponsorAction: (...args: unknown[]) => actions.assignPooledSponsorAction(...args),
  sendSponsorRenewalLinkAction: (...args: unknown[]) => actions.sendSponsorRenewalLinkAction(...args)
}));

const sponsor = (overrides: Partial<ModerationSponsorView> = {}): ModerationSponsorView => ({
  id: 7,
  name: 'Panadería La Espiga',
  sector: 'Panadería',
  level: 'PLATA',
  status: 'PENDING',
  needsDecision: true,
  amountCents: 25_000,
  feeCents: 3_750,
  vatCents: 788,
  refundCents: 29_538,
  matching: false,
  promo: '10 % en la merienda',
  code: 'ESPIGA10',
  contactPerson: 'Lucía Martín',
  phone: '+34 600 000 000',
  email: 'hola@laespiga.test',
  autoRenew: true,
  paidAt: '2026-11-08T10:00:00.000Z',
  expiresAt: '2027-11-08T10:00:00.000Z',
  logoSrc: null,
  initiative: { id: 3, title: 'Toldos para el patio', walletEscrowId: 'WLT-ESC-101', status: 'FUNDRAISING' },
  money: { originCents: 25_000, placed: [], poolCents: 0, poolDeadline: null },
  isRenewal: false,
  renewed: false,
  renewalOpen: false,
  renewalOpensAt: null,
  assignable: [],
  ...overrides
});

const renderCard = (view: ModerationSponsorView, canModerate = true) =>
  renderWithIntl(
    <ApprovalsNoticeProvider>
      <SponsorModerationCard orgSlug="colegio-sol" sponsor={view} canModerate={canModerate} maxLogoBytes={2 * 1024 * 1024} />
    </ApprovalsNoticeProvider>
  );

afterEach(() => {
  vi.clearAllMocks();
});

describe('Sprint 4.2b · reglas de la moderación de comercios', () => {
  it('solo pide decisión un comercio pendiente y cobrado; la bandeja pone primero los pendientes (el más antiguo arriba) y al final los cerrados', () => {
    expect(needsDecision({ status: 'PENDING', paidAt: '2026-11-08T10:00:00.000Z' })).toBe(true);
    expect(needsDecision({ status: 'PENDING', paidAt: null })).toBe(false);
    expect(needsDecision({ status: 'APPROVED', paidAt: '2026-11-08T10:00:00.000Z' })).toBe(false);
    const rows = [
      { id: 1, status: 'REJECTED' as const, paidAt: '2026-11-01T00:00:00.000Z' },
      { id: 2, status: 'APPROVED' as const, paidAt: '2026-11-02T00:00:00.000Z' },
      { id: 3, status: 'PENDING' as const, paidAt: '2026-11-05T00:00:00.000Z' },
      { id: 4, status: 'PENDING' as const, paidAt: '2026-11-03T00:00:00.000Z' }
    ];
    expect(sortForModeration(rows).map((row) => row.id)).toEqual([4, 3, 2, 1]);
  });

  it('el distintivo vale 12 meses desde la aprobación y el motivo de no admitir tiene un mínimo', () => {
    expect(badgeExpiryFrom(new Date('2026-11-08T10:00:00.000Z')).toISOString()).toBe('2027-11-08T10:00:00.000Z');
    expect(rejectSponsorSchema.safeParse({ sponsorId: 7, reason: 'corto' }).success).toBe(false);
    expect(rejectSponsorSchema.safeParse({ sponsorId: 7, reason: '  Ya tenemos este patrocinio cubierto.  ' }).success).toBe(true);
  });

  it('Veri*factu: una rectificativa lleva importes negativos con su signo y su tipo entra en la huella', () => {
    expect(formatCents(-4_538)).toBe('-45.38');
    expect(formatCents(-50)).toBe('-0.50');
    expect(formatCents(50)).toBe('0.50');
    const base = { invoiceNumber: 'REC-2026-0001', taxAmountCents: -788, totalAmountCents: -4_538, prevVerifactuHash: 'A'.repeat(64), issuedAt: new Date('2026-11-08T10:00:00.000Z') };
    const rectifying = recordOfInvoice({ ...base, invoiceType: 'R1' }, 'A58818501');
    expect(rectifying.invoiceType).toBe('R1');
    expect(rectifying.amountTotal).toBe('-45.38');
    expect(computeVerifactuHash(rectifying)).not.toBe(computeVerifactuHash(recordOfInvoice({ ...base, invoiceType: 'F1' }, 'A58818501')));
    expect(recordOfInvoice(base, 'A58818501').invoiceType).toBe('F1');
  });
});

describe('Sprint 4.2b · tarjeta del comercio en la bandeja', () => {
  it('enseña el importe íntegro, la gestión aparte y el contacto, sin el CIF; aprueba y anuncia el resultado', async () => {
    actions.approveSponsorAction.mockResolvedValue({ status: 'OK' });
    renderCard(sponsor());
    expect(screen.getByRole('heading', { level: 3, name: /Panadería La Espiga/ })).toBeInTheDocument();
    expect(screen.getByText('Por revisar')).toBeInTheDocument();
    expect(screen.getByText('Patrocinio íntegro a la hucha')).toBeInTheDocument();
    expect(screen.getByText(/37,50\s€ \+ IVA 7,88\s€/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'hola@laespiga.test' })).toHaveAttribute('href', 'mailto:hola@laespiga.test');
    await userEvent.click(screen.getByRole('button', { name: /Aprobar comercio/ }));
    await waitFor(() => expect(actions.approveSponsorAction).toHaveBeenCalledWith('colegio-sol', { sponsorId: 7 }));
    await waitFor(() => expect(screen.getByTestId('approvals-notice')).toHaveTextContent('Panadería La Espiga ya es comercio amigo'));
    expect(refresh).toHaveBeenCalled();
  });

  it('no admitir pide un motivo antes de llamar al servidor y dice cuánto se devuelve', async () => {
    actions.rejectSponsorAction.mockResolvedValue({ status: 'OK' });
    renderCard(sponsor());
    await userEvent.click(screen.getByRole('button', { name: /No admitir/ }));
    const reason = screen.getByLabelText('Motivo (lo leerá el comercio en su email)');
    await waitFor(() => expect(reason).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: /No admitir y devolver 295,38/ }));
    expect(actions.rejectSponsorAction).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(`al menos ${SPONSOR_REJECTION_REASON_MIN} caracteres`);
    // El error queda asociado al campo y el foco vuelve a él.
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(reason).toHaveAccessibleDescription(/al menos 10 caracteres/);
    expect(reason).toHaveFocus();
    await userEvent.type(reason, 'Ya tenemos una panadería en esta campaña.');
    await userEvent.click(screen.getByRole('button', { name: /No admitir y devolver/ }));
    await waitFor(() => expect(actions.rejectSponsorAction).toHaveBeenCalledWith('colegio-sol', { sponsorId: 7, reason: 'Ya tenemos una panadería en esta campaña.' }));
    await waitFor(() => expect(screen.getByTestId('approvals-notice')).toHaveTextContent('Le devolvemos 295,38'));
  });

  it('un error del servidor se dice en la tarjeta; el Super-Admin solo lee y no ve los botones ni el logotipo', async () => {
    actions.approveSponsorAction.mockResolvedValue({ status: 'ERROR', reason: 'MATCHING_TAKEN' });
    const first = renderCard(sponsor({ matching: true }));
    expect(screen.getByText('Patrocinio íntegro a la bolsa Matching 2x')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Aprobar comercio/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('ya la tiene otro comercio aprobado'));
    first.unmount();

    renderCard(sponsor(), false);
    expect(screen.queryByRole('button', { name: /Aprobar comercio/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Solo las dos personas firmantes/)).toBeInTheDocument();
    expect(screen.queryByText('Subir su logotipo')).not.toBeInTheDocument();
  });

  it('cancelar devuelve el foco a «No admitir»; un comercio devuelto no habla de renovación ni de hucha', async () => {
    const view = renderCard(sponsor());
    await userEvent.click(screen.getByRole('button', { name: /No admitir/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^No admitir$/ })).toHaveFocus());
    view.unmount();
    renderCard(sponsor({ status: 'REJECTED', needsDecision: false }));
    expect(screen.getByText('Patrocinio devuelto al comercio')).toBeInTheDocument();
    expect(screen.queryByText(/Le enviaremos el enlace para renovar 30 días antes/)).not.toBeInTheDocument();
    expect(screen.queryByText('Patrocinio íntegro a la hucha')).not.toBeInTheDocument();
  });

  it('un comercio aprobado dice hasta cuándo es visible y permite cambiar su logotipo', () => {
    renderCard(sponsor({ status: 'APPROVED', needsDecision: false, logoSrc: '/api/files/public/abcdefghijklmnopqrst' }));
    expect(screen.getByText('Aprobado · visible')).toBeInTheDocument();
    expect(screen.getByText(/Visible en vuestra página hasta el/)).toBeInTheDocument();
    // Decorativo: el nombre ya está en el encabezado de al lado (no se lee dos veces).
    expect(document.querySelector('img[src="/api/files/public/abcdefghijklmnopqrst"]')).toHaveAttribute('alt', '');
    expect(screen.getByText('Cambiar su logotipo')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Aprobar comercio/ })).not.toBeInTheDocument();
  });
});

describe('Sprint 4.2b · contador de «Aprobaciones»', () => {
  it('lleva el número y un texto para el lector de pantalla; sin pendientes no hay contador', () => {
    const view = renderWithIntl(<PanelNav orgSlug="colegio-sol" pendingApprovals={3} />);
    const link = screen.getByRole('link', { name: /Aprobaciones/ });
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link).toHaveTextContent('3 decisiones pendientes');
    view.unmount();
    renderWithIntl(<PanelNav orgSlug="colegio-sol" pendingApprovals={0} />);
    expect(screen.queryByTestId('approvals-pending')).not.toBeInTheDocument();
  });
});
