import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { InvitationForm } from '@/components/auth/invitation-form';
import { TwoFactorSetup } from '@/components/auth/two-factor-setup';
import { renderWithIntl } from '../utils/render-with-intl';

/**
 * Sprint 5.9 · El foco de los formularios de acceso se da cuando React ya ha pintado el error (`useFocusFirstInvalid`, sobre `useFocusPainted`), no un
 * fotograma después. El segundo factor ya lo comprueba `polish-5-5b-forms.spec.tsx`; aquí, el alta del doble factor y la activación de la invitación
 * (la revisión de experiencia no pudo recorrerlos en vivo sin una cuenta de firmante).
 */

const mocks = vi.hoisted(() => ({ enable: vi.fn(), verifyTotp: vi.fn(), verifyBackupCode: vi.fn(), push: vi.fn(), inspect: vi.fn(), accept: vi.fn(), acceptWithSession: vi.fn() }));
vi.mock('@/lib/auth/auth-client', () => ({
  authClient: { twoFactor: { enable: mocks.enable, verifyTotp: mocks.verifyTotp, verifyBackupCode: mocks.verifyBackupCode } },
  authErrorCode: (error: { code?: string } | null) => error?.code ?? 'UNKNOWN'
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push, refresh: vi.fn() }) }));
vi.mock('next/image', () => ({ default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} /> }));
vi.mock('@/app/[locale]/(auth)/invitacion/actions', () => ({
  inspectInvitationAction: mocks.inspect,
  acceptInvitationAction: mocks.accept,
  acceptInvitationWithSessionAction: mocks.acceptWithSession
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));

describe('alta del doble factor', () => {
  it('una contraseña que no vale se dice junto a su campo, con el foco en él y sin aviso general', async () => {
    mocks.enable.mockResolvedValue({ error: { code: 'INVALID_PASSWORD' } });
    renderWithIntl(<TwoFactorSetup enabled={false} nextUrl="/panel/cervantes" />);
    const field = screen.getByLabelText(/contraseña/i);
    await userEvent.type(field, 'una-clave-equivocada');
    await userEvent.click(screen.getByRole('button', { name: /Empezar/ }));
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('un código que no vale, ya con el secreto escaneado, devuelve el foco al campo del código', async () => {
    mocks.enable.mockResolvedValue({ data: { totpURI: 'otpauth://totp/KORUM:ana?secret=ABCDEFGHIJKLMNOP&issuer=KORUM', backupCodes: ['aaaaa-bbbbb', 'ccccc-ddddd'] } });
    mocks.verifyTotp.mockResolvedValue({ error: { code: 'INVALID_CODE' } });
    renderWithIntl(<TwoFactorSetup enabled={false} nextUrl="/panel/cervantes" />);
    await userEvent.type(screen.getByLabelText(/contraseña/i), 'la-clave-correcta-123');
    await userEvent.click(screen.getByRole('button', { name: /Empezar/ }));
    await screen.findByRole('heading', { name: /Escanea|Escaneja/i });
    await userEvent.click(screen.getByRole('checkbox'));
    const field = await screen.findByLabelText(/Primer código/);
    await userEvent.type(field, '000000');
    await userEvent.click(screen.getByRole('button', { name: /Activar y continuar/ }));
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
    await waitFor(() => expect(document.activeElement).toBe(field));
  });
});

describe('activación de la invitación', () => {
  const view = { purpose: 'SIGNER', email: 'ana@cervantes.example', organizationName: 'AMPA Cervantes', organizationSlug: 'cervantes', roleLabel: 'Presidencia', hasPassword: false, signedInAsInvitee: false, signedInAsOther: false };

  it('contraseñas que no coinciden: el foco va al primer campo con error, con su aviso junto al campo', async () => {
    // El token viaja en el fragmento de la dirección (`#t=`).
    window.history.replaceState(null, '', '/invitacion#t=token-de-prueba');
    mocks.inspect.mockResolvedValue(view);
    renderWithIntl(<InvitationForm />);
    const password = await screen.findByLabelText(/Crea tu contraseña/);
    const repeat = screen.getByLabelText('Repite la contraseña');
    await userEvent.type(password, 'una-clave-larga-123');
    await userEvent.type(repeat, 'otra-distinta-1234');
    await userEvent.click(screen.getByRole('button', { name: /Crear contraseña y continuar/ }));
    await waitFor(() => expect(repeat).toHaveAttribute('aria-invalid', 'true'));
    await waitFor(() => expect(document.activeElement).toBe(repeat));
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it('una contraseña demasiado corta: el foco va a la contraseña', async () => {
    // El token viaja en el fragmento de la dirección (`#t=`).
    window.history.replaceState(null, '', '/invitacion#t=token-de-prueba');
    mocks.inspect.mockResolvedValue(view);
    renderWithIntl(<InvitationForm />);
    const password = await screen.findByLabelText(/Crea tu contraseña/);
    await userEvent.type(password, 'corta');
    await userEvent.click(screen.getByRole('button', { name: /Crear contraseña y continuar/ }));
    await waitFor(() => expect(password).toHaveAttribute('aria-invalid', 'true'));
    await waitFor(() => expect(document.activeElement).toBe(password));
  });
});
