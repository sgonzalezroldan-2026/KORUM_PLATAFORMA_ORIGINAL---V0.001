import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SecondFactorForm } from '@/components/auth/second-factor-form';
import { ResizeLinkResendForm } from '@/components/portal/resize-link-resend-form';
import { renderWithIntl } from '../utils/render-with-intl';

/** Sprint 5.5b, revisión de experiencia: el error del código del segundo factor junto a su campo, y «Usar otro email» tras pedir el enlace de voto. */

const mocks = vi.hoisted(() => ({ verifyTotp: vi.fn(), resend: vi.fn() }));
vi.mock('@/lib/auth/auth-client', () => ({
  authClient: { twoFactor: { verifyTotp: mocks.verifyTotp, verifyBackupCode: vi.fn() } },
  authErrorCode: (error: { code?: string } | null) => error?.code ?? 'UNKNOWN'
}));
vi.mock('@/app/[locale]/(public)/[orgSlug]/votacion/actions', () => ({ resendVoteLinkAction: mocks.resend }));

describe('segundo factor', () => {
  it('un código que no vale se dice junto a su campo, con el foco en él, y no como aviso general', async () => {
    mocks.verifyTotp.mockResolvedValue({ error: { code: 'INVALID_CODE' } });
    renderWithIntl(<SecondFactorForm onDone={vi.fn()} />);
    const field = screen.getByLabelText(/Código/);
    await userEvent.type(field, '123456');
    await userEvent.click(screen.getByRole('button', { name: /Verificar|Entrar|Continuar/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El código de la app no es correcto');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(/El código de la app no es correcto/);
    await vi.waitFor(() => expect(field).toHaveFocus());
  });

  it('un bloqueo sigue en el aviso general (no es culpa del campo)', async () => {
    mocks.verifyTotp.mockResolvedValue({ error: { code: 'ACCOUNT_TEMPORARILY_LOCKED' } });
    renderWithIntl(<SecondFactorForm onDone={vi.fn()} />);
    const field = screen.getByLabelText(/Código/);
    await userEvent.type(field, '123456');
    await userEvent.click(screen.getByRole('button', { name: /Verificar|Entrar|Continuar/ }));
    await screen.findByRole('alert');
    expect(field).not.toHaveAttribute('aria-invalid');
  });
});

describe('«Reenviarme mi enlace de voto»', () => {
  it('tras el envío se puede probar con otro email sin recargar, con el foco en el campo vacío', async () => {
    mocks.resend.mockResolvedValue({ status: 'ACCEPTED' });
    renderWithIntl(<ResizeLinkResendForm orgSlug="cervantes" />);
    await userEvent.type(screen.getByLabelText('Tu email'), 'ana@familias.example');
    await userEvent.click(screen.getByRole('button', { name: 'Enviarme el enlace' }));
    expect(await screen.findByTestId('resize-link-sent')).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Usar otro email' }));
    const field = screen.getByLabelText('Tu email');
    expect(field).toHaveValue('');
    await vi.waitFor(() => expect(field).toHaveFocus());
  });
});
