import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearGateState, summaryWithQueued, type QueuedScan } from '@/components/gate/gate-offline-store';
import { useGateSync } from '@/components/gate/use-gate-sync';

const actions = vi.hoisted(() => ({
  gateSummaryAction: vi.fn(),
  loadGateListAction: vi.fn(),
  syncScansAction: vi.fn()
}));
vi.mock('@/app/[locale]/(dashboard)/panel/[orgSlug]/porteria/scan-actions', () => actions);

const scan = (id: string, quantity: number): QueuedScan => ({ clientScanId: id, payload: `payload-${id}`, quantity, scannedAt: 1_700_000_000_000, serial: `#PASE-${id}` });

describe('aforo de portería con lecturas sin enviar', () => {
  it('suma al aforo del servidor las personas que este móvil dejó entrar y aún no ha enviado', () => {
    expect(summaryWithQueued({ checkedIn: 5, capacity: 9 }, [scan('a', 1), scan('b', 2)])).toEqual({ checkedIn: 8, capacity: 9 });
    expect(summaryWithQueued({ checkedIn: 5, capacity: 9 }, [])).toEqual({ checkedIn: 5, capacity: 9 });
  });

  describe('latido', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      clearGateState(7);
      actions.gateSummaryAction.mockReset();
      actions.loadGateListAction.mockReset();
      actions.syncScansAction.mockReset();
      actions.loadGateListAction.mockResolvedValue({ status: 'OK', list: { eventId: 7, generatedAt: 1, passes: [] }, summary: { checkedIn: 5, capacity: 9 } });
    });
    afterEach(() => {
      vi.useRealTimers();
      clearGateState(7);
    });

    it('la respuesta del latido no hace bajar el contador por debajo de lo ya admitido sin red', async () => {
      const onSummary = vi.fn();
      // El latido pregunta al servidor, que aún no sabe de las dos lecturas guardadas en el móvil: su cifra (5) llega después de ellas.
      let answer: (value: unknown) => void = () => undefined;
      actions.gateSummaryAction.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
      actions.syncScansAction.mockImplementation(() => new Promise(() => undefined));
      const { result } = renderHook(() => useGateSync(7, onSummary, () => undefined));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      act(() => {
        result.current.enqueue(scan('a', 1));
        result.current.enqueue(scan('b', 2));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      onSummary.mockClear();
      await act(async () => {
        answer({ status: 'OK', summary: { checkedIn: 5, capacity: 9 } });
        await Promise.resolve();
      });
      // El envío de la cola sigue en curso (nunca responde en este caso): se ignora la cifra suelta y no se muestra un 5 que ya no es cierto.
      expect(onSummary).not.toHaveBeenCalledWith({ checkedIn: 5, capacity: 9 });
    });

    it('sin envío en curso, el latido muestra la cifra del servidor más lo pendiente', async () => {
      const onSummary = vi.fn();
      actions.gateSummaryAction.mockResolvedValue({ status: 'OK', summary: { checkedIn: 5, capacity: 9 } });
      actions.syncScansAction.mockRejectedValue(new Error('sin red'));
      const { result } = renderHook(() => useGateSync(7, onSummary, () => undefined));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      act(() => {
        result.current.enqueue(scan('a', 1));
        result.current.enqueue(scan('b', 2));
      });
      onSummary.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(onSummary).toHaveBeenLastCalledWith({ checkedIn: 8, capacity: 9 });
    });
  });
});
