import type { ReactNode } from 'react';

/**
 * Una línea de la pizarra: rótulo a la izquierda y valor a la derecha. Un importe nunca se parte (el rótulo baja de línea). Un valor que es una frase
 * («0,49 € por unidad (se suman al comprador)», la beca de medalla con su ahorro) lleva `phrase`: si no cabe junto al rótulo baja entero a su propia línea,
 * en vez de dejar al rótulo sin sitio y partirlo letra a letra (repaso del Sprint 5.6).
 */
export function Row({ label, value, tone = 'plain', phrase = false }: { label: ReactNode; value: ReactNode; tone?: 'plain' | 'emerald' | 'gold' | 'sky' | 'total'; phrase?: boolean }) {
  const color = { plain: 'text-slate-200', emerald: 'text-emerald-300', gold: 'text-amber-300', sky: 'text-sky-300', total: 'text-amber-300 font-extrabold' }[tone];
  if (phrase) {
    return (
      <div className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-sm ${color}`} data-board-row="phrase">
        <span>{label}</span>
        <span className="ms-auto text-end font-bold tabular-nums text-white">{value}</span>
      </div>
    );
  }
  return (
    <div className={`flex items-baseline justify-between gap-4 text-sm ${color}`} data-board-row="amount">
      <span className="min-w-0 wrap-anywhere">{label}</span>
      <span className="shrink-0 whitespace-nowrap text-end font-bold tabular-nums text-white">{value}</span>
    </div>
  );
}
