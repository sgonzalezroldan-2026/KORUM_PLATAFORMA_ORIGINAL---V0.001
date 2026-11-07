import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AccountContributions, AccountPasses } from '@/components/account/account-activity';
import { EraseAccount } from '@/components/account/erase-account';
import { RESERVED_SLUGS } from '@/core/onboarding/registration-rules';
import { IDENTITY_PROOF_PATHS } from '@/lib/auth/auth-hooks';
import { PASSKEY_NAME_MAX, PASSKEY_REGISTRATION_PATHS, SESSION_REPLACING_PATHS } from '@/lib/auth/passkey-hooks';
import { isProtectedPath } from '@/lib/auth/protected-paths';
import { ACCOUNT_ERASURE_RULE, ACCOUNT_EXPORT_RULE } from '@/lib/rate-limit-rules';
import { RATE_LIMIT_PURGE_RULES } from '@/core/jobs/handlers/housekeeping';
import { exportFileName } from '@/services/account/account-privacy.service';
import type { AccountOverview } from '@/repositories/account.repository';
import { renderWithIntl } from '../utils/render-with-intl';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, prefetch: _prefetch, ...props }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));
// Las acciones de servidor no se ejecutan en jsdom: aquí solo se comprueba lo que se ve y cuándo se pide la acción.
const eraseAccountAction = vi.fn(async () => ({ status: 'ERASED' as const, retainedFiscalRecords: 1 }));
vi.mock('@/app/[locale]/(account)/mi-cuenta/actions', () => ({ eraseAccountAction: (...args: unknown[]) => eraseAccountAction(...(args as [])) }));

describe('Mi cuenta · rutas, límites y pruebas de identidad', () => {
  it('Mi cuenta exige sesión en los tres idiomas y su nombre no puede ser el de una entidad', () => {
    for (const path of ['/mi-cuenta', '/ca/mi-cuenta', '/en/mi-cuenta/certificados', '/mi-cuenta/certificados/12']) expect(isProtectedPath(path), path).toBe(true);
    for (const path of ['/mi-cuentas', '/cervantes/mi-cuenta', '/']) expect(isProtectedPath(path), path).toBe(false);
    expect(RESERVED_SLUGS.has('mi-cuenta')).toBe(true);
  });

  it('entrar con una llave de acceso cuenta como segundo factor; registrar una pasa por la guardia de prueba reciente', () => {
    expect(IDENTITY_PROOF_PATHS['/passkey/verify-authentication']).toBe('second-factor');
    expect([...PASSKEY_REGISTRATION_PATHS].sort()).toEqual(['/passkey/generate-register-options', '/passkey/verify-registration']);
    // El nombre de la llave tiene tope también en el servidor, igual que en el formulario.
    expect(PASSKEY_NAME_MAX).toBe(40);
  });

  it('confirmar la identidad con el código, el enlace o una llave sustituye la sesión anterior de esa persona', () => {
    expect([...SESSION_REPLACING_PATHS].sort()).toEqual(['/magic-link/verify', '/passkey/verify-authentication', '/sign-in/email-otp']);
  });

  it('exportar y suprimir tienen tope diario por persona, y la limpieza diaria purga sus contadores', () => {
    expect(ACCOUNT_EXPORT_RULE).toMatchObject({ limit: 10, windowMs: 86_400_000 });
    expect(ACCOUNT_ERASURE_RULE).toMatchObject({ limit: 5, windowMs: 86_400_000 });
    expect(RATE_LIMIT_PURGE_RULES).toEqual(expect.arrayContaining([ACCOUNT_EXPORT_RULE, ACCOUNT_ERASURE_RULE]));
  });

  it('el fichero exportado se llama por la fecha, sin datos de la persona', () => {
    expect(exportFileName('json', new Date('2026-11-07T10:00:00Z'))).toBe('korum-mis-datos-2026-11-07.json');
    expect(exportFileName('pdf', new Date('2026-11-07T10:00:00Z'))).toBe('korum-mis-datos-2026-11-07.pdf');
  });
});

const contributionRow = (overrides: Partial<AccountOverview['contributions'][number]> = {}): AccountOverview['contributions'][number] => ({
  id: 1,
  createdAt: new Date('2026-10-01T10:00:00Z'),
  type: 'DONATION',
  status: 'COMPLETED',
  amountCents: 2_500,
  guaranteeContributionCents: 180,
  totalChargedCents: 2_680,
  refundedCents: 0,
  groupName: null,
  initiative: { id: 4, title: 'Toldos para el patio' },
  organization: { slug: 'cervantes', name: 'CEIP Cervantes' },
  ...overrides
});

describe('Mi cuenta · historial', () => {
  it('cada aportación enlaza a su iniciativa y dice su estado en texto, con el total cobrado', () => {
    renderWithIntl(<AccountContributions contributions={[contributionRow(), contributionRow({ id: 2, type: 'TICKET', status: 'REFUNDED', guaranteeContributionCents: 0, totalChargedCents: 555 })]} />);
    expect(screen.getAllByRole('link', { name: 'Toldos para el patio' })[0]).toHaveAttribute('href', '/cervantes/iniciativas/4');
    expect(screen.getByText('Completada')).toBeInTheDocument();
    expect(screen.getByText('Devuelta')).toBeInTheDocument();
    expect(screen.getByText('26,80 €')).toBeInTheDocument();
    expect(screen.getByText('Incluye tu aportación voluntaria a KORUM.')).toBeInTheDocument();
  });

  it('sin aportaciones: estado vacío con la siguiente acción', () => {
    renderWithIntl(<AccountContributions contributions={[]} />);
    expect(screen.getByRole('heading', { name: 'Aún no has aportado con esta cuenta' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Buscar mi centro o club' })).toHaveAttribute('href', '/');
  });

  it('una entrada válida enlaza con la firma de vista; una anulada lo dice y no enlaza', () => {
    const base = { serialCode: 'TKT-1', quantity: 2, raffleNumbers: [], subtype: 'EVENT' as const, initiative: { title: 'Festival de primavera', closesAt: new Date('2026-12-01T18:00:00Z'), ticketVenue: 'Patio', organization: { slug: 'cervantes', name: 'CEIP Cervantes' } } };
    renderWithIntl(
      <AccountPasses
        passes={[
          { ...base, uuid: 'a', revokedAt: null, href: '/cervantes/entrada/a?sig=vista' },
          { ...base, uuid: 'b', serialCode: 'TKT-2', revokedAt: new Date(), href: '/cervantes/entrada/b?sig=vista' }
        ]}
      />
    );
    const links = screen.getAllByRole('link', { name: /^Ver mi entrada\s*· Festival de primavera$/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/cervantes/entrada/a?sig=vista');
    expect(screen.getByText(/Esta entrada está anulada/)).toBeInTheDocument();
    expect(screen.getAllByText('2 entradas')).toHaveLength(2);
  });
});

describe('Mi cuenta · suprimir (QA-REG03)', () => {
  it('explica qué se borra y qué se conserva por ley; el botón espera a que se marque la casilla', async () => {
    const ensureFresh = vi.fn(async (then: () => void) => then());
    renderWithIntl(<EraseAccount block={null} ensureFresh={ensureFresh} request={vi.fn()} />);
    expect(screen.getByText(/Por ley conservamos/)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Suprimir mi cuenta' });
    expect(button).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Entiendo que mi cuenta se borra para siempre' }));
    await userEvent.click(button);
    expect(ensureFresh).toHaveBeenCalledTimes(1);
    expect(eraseAccountAction).toHaveBeenCalledWith({ confirm: true });
    const done = await screen.findByRole('heading', { name: 'Tu cuenta se ha suprimido' });
    expect(done).toHaveFocus();
    expect(screen.getByText(/y los datos fiscales de 1 donación con certificado/)).toBeInTheDocument();
  });

  it('si firma por una entidad, lo explica y no ofrece el botón', () => {
    renderWithIntl(<EraseAccount block="ACTIVE_SIGNER" ensureFresh={vi.fn()} request={vi.fn()} />);
    expect(screen.getByText(/Firmas por una entidad/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suprimir mi cuenta' })).toBeNull();
  });
});
