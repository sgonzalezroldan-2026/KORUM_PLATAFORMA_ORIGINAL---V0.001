import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TOOLTIP_DELAY_MS, DelayedTooltip } from '@/components/ui/delayed-tooltip';
import { renderWithIntl } from '../utils/render-with-intl';

function setup(delayMs?: number) {
  renderWithIntl(
    <DelayedTooltip content="Ayuda contextual" delayMs={delayMs}>
      <button type="button">Disparador</button>
    </DelayedTooltip>
  );
  return screen.getByRole('button', { name: 'Disparador' });
}

describe('QA-C02 · tooltip diferido exacto (1000 ms)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('el retardo por defecto es de 1000 ms', () => {
    expect(DEFAULT_TOOLTIP_DELAY_MS).toBe(1000);
  });

  it('no aparece antes de 1000 ms con el puntero y aparece justo al llegar a 1000 ms', () => {
    const trigger = setup();
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });

    act(() => {
      vi.advanceTimersByTime(899);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Ayuda contextual');
  });

  it('desaparece al salir el puntero', () => {
    const trigger = setup();
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('si el puntero sale antes de 1000 ms, la ayuda no aparece nunca', () => {
    const trigger = setup();
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('con teclado aparece al enfocar, sin retardo, y se asocia al disparador', () => {
    const trigger = setup();
    act(() => {
      trigger.focus();
    });
    const tooltip = screen.getByRole('tooltip');
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id);

    act(() => {
      trigger.blur();
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(trigger).not.toHaveAttribute('aria-describedby');
  });

  it('se descarta con Escape (WCAG 1.4.13)', () => {
    const trigger = setup();
    act(() => {
      trigger.focus();
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('con solo el puntero encima (sin foco) también se descarta con Escape (WCAG 1.4.13)', () => {
    const trigger = setup();
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(trigger).not.toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('el puntero puede entrar en la burbuja sin que se cierre (la burbuja es hija del mismo contenedor)', () => {
    const trigger = setup();
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const tooltip = screen.getByRole('tooltip');
    // Ir del disparador a la burbuja no saca el puntero del contenedor: no hay `pointerleave` del contenedor.
    expect(tooltip.parentElement).toBe(trigger.parentElement);
    fireEvent.pointerOver(tooltip, { pointerType: 'mouse' });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('no deja listeners de teclado colgados al cerrarse', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const trigger = setup();
    act(() => {
      trigger.focus();
    });
    expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
    act(() => {
      trigger.blur();
    });
    expect(remove.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
  });

  it('ignora el puntero táctil (no hay «hover» en el móvil)', () => {
    const trigger = setup();
    fireEvent.pointerEnter(trigger, { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('admite un retardo personalizado', () => {
    const trigger = setup(300);
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });
});
