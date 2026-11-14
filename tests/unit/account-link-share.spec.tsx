import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '../utils/render-with-intl';

/**
 * Sprint 5.5 (QA-X01): la cabecera ya no carga el cliente de Better Auth para saber si hay sesión, y el diálogo de compartir de la ficha llega
 * preparado (montado y oculto) para que la primera pulsación sea rápida.
 */

const pathname = vi.fn<() => string>(() => '/');
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, prefetch: _prefetch, ...props }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => pathname()
}));

const { AccountLink } = await import('@/components/layout/account-link');
const { ShareButton } = await import('@/components/portal/share-button');

beforeAll(() => {
  // jsdom no implementa el diálogo modal.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubSession(body: unknown, ok = true) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status: ok ? 200 : 500, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('AccountLink sin el cliente de Better Auth', () => {
  it('con sesión enseña «Mi cuenta»; los dos enlaces de la cabecera comparten una sola consulta a /api/auth/get-session', async () => {
    pathname.mockReturnValue('/precios');
    const fetchMock = stubSession({ session: { id: 's1' }, user: { id: 'u1' } });
    renderWithIntl(
      <>
        <AccountLink className="a" />
        <AccountLink className="b" />
      </>
    );
    // Mientras se pregunta, se ve el acceso (lo que ve la mayoría).
    expect(screen.getAllByTestId('header-account-link')[0]).toHaveTextContent('Iniciar sesión');
    await waitFor(() => expect(screen.getAllByTestId('header-account-link').map((link) => link.textContent)).toEqual(['Mi cuenta', 'Mi cuenta']));
    expect(screen.getAllByTestId('header-account-link')[0]).toHaveAttribute('href', '/mi-cuenta');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/get-session');
  });

  it('sin sesión (null), con un error o sin red se queda en «Iniciar sesión»', async () => {
    for (const [index, stub] of [() => stubSession(null), () => stubSession({ error: 'x' }, false), () => vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))].entries()) {
      pathname.mockReturnValue(`/sin-sesion-${index}`);
      stub();
      const { unmount } = renderWithIntl(<AccountLink className="a" loginHref="/login?next=%2Fcervantes" />);
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.getByTestId('header-account-link')).toHaveTextContent('Iniciar sesión');
      expect(screen.getByTestId('header-account-link')).toHaveAttribute('href', '/login?next=%2Fcervantes');
      unmount();
    }
  });
});

describe('ShareButton: el diálogo llega preparado', () => {
  it('su contenido ya está montado, oculto dentro del diálogo cerrado, y se abre con el mismo texto', async () => {
    const target = { title: 'Ventiladores', entityName: 'CEIP Cervantes', url: 'https://korum.example/cervantes/iniciativas/1', groups: [] };
    const { container } = renderWithIntl(<ShareButton target={target} />);
    const dialog = container.querySelector('dialog');
    expect(dialog).not.toHaveAttribute('open');
    expect(dialog).toHaveTextContent('Ventiladores');
    // Cerrado no es accesible: ningún lector de pantalla lo encuentra.
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Compartir' }));
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByRole('dialog', { name: 'Compartir en KORUM' })).toHaveTextContent('¡Súmate en KORUM a «Ventiladores» en CEIP Cervantes!');
  });
});
