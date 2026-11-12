import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalsNoticeProvider } from '@/components/panel/approvals-notice';
import { HandoverStatus } from '@/components/panel/handover-status';
import { SignatureModeForm } from '@/components/panel/signature-mode-form';
import { LOCALES } from '@/i18n/routing';
import type { HandoverView } from '@/services/panel/signer-team.service';
import { renderWithIntl } from '../utils/render-with-intl';

/**
 * Sprint 5.2 · modo de firma y relevo sin visto bueno (decisión del promotor, 2026-11-12): la pantalla del equipo que firma ofrece a Dirección cambiar entre
 * una y dos firmas con una confirmación expresa, y quien sale de un relevo no puede retirarlo.
 */

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const actions = { changeSignatureModeAction: vi.fn(), cancelHandoverAction: vi.fn(), resendHandoverAction: vi.fn() };
vi.mock('@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/ajustes/team-actions', () => ({
  changeSignatureModeAction: (...args: unknown[]) => actions.changeSignatureModeAction(...args),
  cancelHandoverAction: (...args: unknown[]) => actions.cancelHandoverAction(...args),
  resendHandoverAction: (...args: unknown[]) => actions.resendHandoverAction(...args)
}));
vi.mock('@/components/account/reauth-dialog', () => ({ ReauthDialog: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
});

const handover = (overrides: Partial<HandoverView> = {}): HandoverView => ({
  id: 'h1',
  role: 'DIRECTOR',
  displayName: 'Pau Ferrer',
  email: 'pa•••@familias.example',
  roleLabel: 'Dirección del centro',
  expiresAt: '2099-01-01T10:00:00.000Z',
  expired: false,
  selfProposed: false,
  proposedByMe: false,
  outgoingIsMe: false,
  ...overrides
});

describe('modo de firma de la entidad', () => {
  it('con doble firma, Dirección pasa a firma única tras marcar que entiende lo que cambia, y la acción lleva el modo y la confirmación', async () => {
    actions.changeSignatureModeAction.mockResolvedValue({ status: 'OK' });
    renderWithIntl(
      <ApprovalsNoticeProvider>
        <SignatureModeForm orgSlug="sol" mode="DOUBLE" canChange email="d@sol.example" />
      </ApprovalsNoticeProvider>
    );
    expect(screen.getByTestId('signature-mode-current')).toHaveTextContent('Doble firma');
    await userEvent.click(screen.getByTestId('signature-mode-open'));
    expect(screen.getByTestId('signature-mode-submit')).toBeDisabled();
    expect(screen.getByText(/el puesto de Cofirma desaparece al momento/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('signature-mode-confirm'));
    await userEvent.click(screen.getByTestId('signature-mode-submit'));
    await waitFor(() => expect(actions.changeSignatureModeAction).toHaveBeenCalledWith('sol', { mode: 'SINGLE', confirm: true }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('con firma única se ofrece volver a doble firma, y quien no es Dirección solo lee el modo', async () => {
    const { unmount } = renderWithIntl(
      <ApprovalsNoticeProvider>
        <SignatureModeForm orgSlug="sol" mode="SINGLE" canChange email="d@sol.example" />
      </ApprovalsNoticeProvider>
    );
    expect(screen.getByTestId('signature-mode-current')).toHaveTextContent('Firma única');
    expect(screen.getByTestId('signature-mode-open')).toHaveTextContent('Volver a doble firma');
    unmount();
    renderWithIntl(
      <ApprovalsNoticeProvider>
        <SignatureModeForm orgSlug="sol" mode="DOUBLE" canChange={false} email="c@sol.example" />
      </ApprovalsNoticeProvider>
    );
    expect(screen.queryByTestId('signature-mode-open')).not.toBeInTheDocument();
    expect(screen.getByText('Solo Dirección puede cambiar esto.')).toBeInTheDocument();
  });

  it('un rechazo del servidor se dice con texto junto al formulario y no recarga la página', async () => {
    actions.changeSignatureModeAction.mockResolvedValue({ status: 'ERROR', reason: 'FORBIDDEN' });
    renderWithIntl(
      <ApprovalsNoticeProvider>
        <SignatureModeForm orgSlug="sol" mode="DOUBLE" canChange email="d@sol.example" />
      </ApprovalsNoticeProvider>
    );
    await userEvent.click(screen.getByTestId('signature-mode-open'));
    await userEvent.click(screen.getByTestId('signature-mode-confirm'));
    await userEvent.click(screen.getByTestId('signature-mode-submit'));
    expect(await screen.findByText(/tienes que haber entrado con tu código de verificación/)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('si otra persona ya cambió el modo, la pantalla se actualiza sola y lo dice (en lugar de pedir que se recargue)', async () => {
    actions.changeSignatureModeAction.mockResolvedValue({ status: 'ERROR', reason: 'ALREADY_IN_MODE' });
    renderWithIntl(
      <ApprovalsNoticeProvider>
        <SignatureModeForm orgSlug="sol" mode="DOUBLE" canChange email="d@sol.example" />
      </ApprovalsNoticeProvider>
    );
    await userEvent.click(screen.getByTestId('signature-mode-open'));
    await userEvent.click(screen.getByTestId('signature-mode-confirm'));
    await userEvent.click(screen.getByTestId('signature-mode-submit'));
    expect(await screen.findByText('La entidad ya firma así: hemos actualizado la pantalla.')).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('antes de pasar a firma única se cuenta todo lo que cambia (nadie más revisa, portería, lo pendiente) y el foco va a la explicación; al cancelar vuelve al botón', async () => {
    renderWithIntl(
      <ApprovalsNoticeProvider>
        <SignatureModeForm orgSlug="sol" mode="DOUBLE" canChange email="d@sol.example" />
      </ApprovalsNoticeProvider>
    );
    await userEvent.click(screen.getByTestId('signature-mode-open'));
    const effects = screen.getByTestId('signature-mode-effects');
    expect(effects).toHaveTextContent('Nadie más comprobará lo que firmes');
    expect(effects).toHaveTextContent('PIN y las sesiones de portería de todos los eventos');
    expect(effects).toHaveTextContent('quedará aprobado sin otra firma');
    expect(screen.getByText(/el puesto de Cofirma desaparece al momento/)).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByTestId('signature-mode-open')).toHaveFocus();
    await userEvent.click(screen.getByTestId('signature-mode-open'));
    expect(screen.getByTestId('signature-mode-confirm')).not.toBeChecked();
  });

  it.each(LOCALES)('el modo y su ayuda salen con texto en %s', (locale) => {
    renderWithIntl(
      <ApprovalsNoticeProvider>
        <SignatureModeForm orgSlug="sol" mode="SINGLE" canChange email="d@sol.example" />
      </ApprovalsNoticeProvider>,
      locale
    );
    expect(screen.getByTestId('signature-mode-current').textContent?.length).toBeGreaterThan(20);
    expect(screen.getByTestId('signature-mode-open').textContent?.length).toBeGreaterThan(5);
  });
});

describe('relevo sin visto bueno', () => {
  it('quien propuso el relevo puede retirarlo y reenviar la invitación', async () => {
    renderWithIntl(
      <ApprovalsNoticeProvider>
        <HandoverStatus orgSlug="sol" handover={handover({ proposedByMe: true })} seatLabel="Dirección" canEdit />
      </ApprovalsNoticeProvider>
    );
    expect(screen.getByTestId('handover-status')).toHaveTextContent('Has invitado a Pau Ferrer');
    expect(screen.getByRole('button', { name: 'Retirar el relevo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reenviar la invitación' })).toBeInTheDocument();
  });

  it('quien sale no tiene veto: ve que le sustituyen pero no puede retirarlo ni dar o negar un visto bueno', () => {
    renderWithIntl(
      <ApprovalsNoticeProvider>
        <HandoverStatus orgSlug="sol" handover={handover({ outgoingIsMe: true })} seatLabel="Dirección" canEdit />
      </ApprovalsNoticeProvider>
    );
    expect(screen.getByTestId('handover-status')).toHaveTextContent('ha invitado a Pau Ferrer');
    expect(screen.getByTestId('handover-status')).toHaveTextContent('ocupar tu puesto');
    expect(screen.queryByRole('button', { name: 'Retirar el relevo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /visto bueno|No estoy de acuerdo/ })).not.toBeInTheDocument();
  });

  it('una invitación caducada se explica y ya no se reenvía', () => {
    renderWithIntl(
      <ApprovalsNoticeProvider>
        <HandoverStatus orgSlug="sol" handover={handover({ expired: true, proposedByMe: true })} seatLabel="Dirección" canEdit />
      </ApprovalsNoticeProvider>
    );
    expect(screen.getByTestId('handover-status')).toHaveTextContent('ha caducado');
    expect(screen.queryByRole('button', { name: 'Reenviar la invitación' })).not.toBeInTheDocument();
  });
});
