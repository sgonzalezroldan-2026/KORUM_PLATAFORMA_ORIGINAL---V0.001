import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast, type ToastInput } from '@/components/ui/toast-provider';
import { renderWithIntl } from '../utils/render-with-intl';

function Launcher({ input }: { input: ToastInput }) {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast(input)}>
      lanzar
    </button>
  );
}

function setup(input: ToastInput) {
  renderWithIntl(
    <ToastProvider>
      <Launcher input={input} />
    </ToastProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: 'lanzar' }));
}

describe('ToastProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('muestra el aviso y se cierra solo a los 6 segundos', () => {
    setup({ tone: 'success', title: 'Aportación recibida' });
    expect(screen.getByText('Aportación recibida')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5999);
    });
    expect(screen.getByText('Aportación recibida')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('Aportación recibida')).not.toBeInTheDocument();
  });

  it('los errores duran 8 segundos y se anuncian en la región de alerta', () => {
    setup({ tone: 'error', title: 'Bizum no ha confirmado el pago' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Bizum no ha confirmado el pago');

    act(() => {
      vi.advanceTimersByTime(7999);
    });
    expect(screen.getByText('Bizum no ha confirmado el pago')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('Bizum no ha confirmado el pago')).not.toBeInTheDocument();
  });

  it('los avisos no urgentes van a la región educada (aria-live polite)', () => {
    setup({ tone: 'info', title: 'Guardado como borrador' });
    const text = screen.getByText('Guardado como borrador');
    expect(text.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.getByRole('alert')).not.toHaveTextContent('Guardado como borrador');
  });

  it('se cierra con el botón, que tiene nombre accesible en el idioma activo', () => {
    setup({ title: 'Hola' });
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar aviso' }));
    expect(screen.queryByText('Hola')).not.toBeInTheDocument();
  });

  it('pausa el cierre automático mientras el puntero está encima', () => {
    setup({ title: 'Léeme con calma' });
    const item = screen.getByText('Léeme con calma').closest('li')!;
    fireEvent.pointerEnter(item);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByText('Léeme con calma')).toBeInTheDocument();

    fireEvent.pointerLeave(item);
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByText('Léeme con calma')).not.toBeInTheDocument();
  });

  it('conserva como máximo 4 avisos visibles', () => {
    renderWithIntl(
      <ToastProvider>
        <Many />
      </ToastProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'seis' }));
    expect(screen.queryByText('aviso 1')).not.toBeInTheDocument();
    expect(screen.queryByText('aviso 2')).not.toBeInTheDocument();
    expect(screen.getByText('aviso 3')).toBeInTheDocument();
    expect(screen.getByText('aviso 6')).toBeInTheDocument();
  });

  describe('en móvil (menos de 640 px)', () => {
    const mockViewport = (mobile: boolean) =>
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: mobile && query === '(max-width: 639px)', media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('tocar el aviso lo cierra', () => {
      mockViewport(true);
      setup({ tone: 'success', title: 'Guardado' });
      fireEvent.click(screen.getByText('Guardado'));
      expect(screen.queryByText('Guardado')).not.toBeInTheDocument();
    });

    it('en escritorio tocar el texto no lo cierra: solo el botón o el tiempo', () => {
      mockViewport(false);
      setup({ tone: 'success', title: 'Guardado' });
      fireEvent.click(screen.getByText('Guardado'));
      expect(screen.getByText('Guardado')).toBeInTheDocument();
    });

    it('la región de avisos va arriba en móvil y abajo desde 640 px, para no tapar los botones de confirmación', () => {
      mockViewport(true);
      setup({ title: 'Hola' });
      const region = screen.getByRole('region');
      expect(region.className).toContain('top-[max(1rem,env(safe-area-inset-top))]');
      expect(region.className).toContain('sm:bottom-4');
      expect(region.className).not.toMatch(/(^|s)bottom-4/);
    });
  });

  it('useToast fuera del proveedor lanza un error claro', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderWithIntl(<Launcher input={{ title: 'x' }} />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});

function Many() {
  const { toast } = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        for (let i = 1; i <= 6; i += 1) toast({ title: `aviso ${i}` });
      }}
    >
      seis
    </button>
  );
}
