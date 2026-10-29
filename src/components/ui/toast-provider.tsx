'use client';

import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastTone = 'success' | 'info' | 'error';

export interface ToastInput {
  tone?: ToastTone;
  /** Texto ya traducido por quien llama. */
  title: string;
  description?: string;
  /** Milisegundos hasta que se cierra sola. Por defecto 6000 (8000 en errores). */
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
  tone: ToastTone;
}

interface ToastApi {
  toast: (input: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const MAX_VISIBLE = 4;
const TONE_STYLES: Record<ToastTone, { icon: string; className: string }> = {
  success: { icon: '✅', className: 'border-varsity-emerald bg-emerald-50 text-emerald-950' },
  info: { icon: 'ℹ️', className: 'border-varsity-navy bg-white text-varsity-navy' },
  error: { icon: '⚠️', className: 'border-red-700 bg-red-50 text-red-950' }
};

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast debe usarse dentro de <ToastProvider>');
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useTranslations('ui.toast');
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const stopTimer = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      stopTimer(id);
      setItems((current) => current.filter((item) => item.id !== id));
    },
    [stopTimer]
  );

  const startTimer = useCallback(
    (id: number, durationMs: number) => {
      stopTimer(id);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), durationMs)
      );
    },
    [dismiss, stopTimer]
  );

  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const tone = input.tone ?? 'info';
      const durationMs = input.durationMs ?? (tone === 'error' ? 8000 : 6000);
      setItems((current) => [...current, { ...input, id, tone, durationMs }].slice(-MAX_VISIBLE));
      startTimer(id, durationMs);
      return id;
    },
    [startTimer]
  );

  useEffect(() => {
    const active = timers.current;
    return () => {
      active.forEach((timer) => clearTimeout(timer));
      active.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss]);

  const renderItem = (item: ToastItem) => (
    <li
      key={item.id}
      className={clsx(
        'animate-toast-in pointer-events-auto flex items-start gap-3 rounded-xl border-2 px-4 py-3 shadow-lg',
        TONE_STYLES[item.tone].className
      )}
      // Pausa el cierre automático mientras se lee o se enfoca (WCAG 2.2.1).
      onPointerEnter={() => stopTimer(item.id)}
      onPointerLeave={() => startTimer(item.id, item.durationMs ?? 6000)}
      onFocus={() => stopTimer(item.id)}
      onBlur={() => startTimer(item.id, item.durationMs ?? 6000)}
    >
      <span aria-hidden="true">{TONE_STYLES[item.tone].icon}</span>
      <div className="min-w-0 flex-1">
        <p className="font-corp font-bold">{item.title}</p>
        {item.description ? <p className="mt-0.5 text-sm">{item.description}</p> : null}
      </div>
      <button
        type="button"
        onClick={() => dismiss(item.id)}
        aria-label={t('dismiss')}
        className="-m-2 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-xl leading-none hover:bg-black/5"
      >
        <span aria-hidden="true">{'×'}</span>
      </button>
    </li>
  );

  const polite = items.filter((item) => item.tone !== 'error');
  const assertive = items.filter((item) => item.tone === 'error');

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="region"
        aria-label={t('region')}
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col gap-2 sm:inset-x-auto sm:inset-e-4 sm:w-96"
      >
        {/* Las dos listas existen siempre para que los lectores de pantalla anuncien lo que se añade. */}
        <div aria-live="polite">
          <ul className="flex flex-col gap-2">{polite.map(renderItem)}</ul>
        </div>
        <div role="alert">
          <ul className="flex flex-col gap-2">{assertive.map(renderItem)}</ul>
        </div>
      </div>
    </ToastContext.Provider>
  );
}
