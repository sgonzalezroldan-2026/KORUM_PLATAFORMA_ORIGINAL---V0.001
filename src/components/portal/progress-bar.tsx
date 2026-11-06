import clsx from 'clsx';

export interface ProgressBarProps {
  /** Entero de 0 a 100. */
  pct: number;
  /** Nombre accesible: qué progreso es (el valor lo anuncia el propio `progressbar`). */
  label: string;
  tone?: 'brand' | 'emerald' | 'sky' | 'amber';
  size?: 'md' | 'lg';
  className?: string;
}

const TONES = {
  brand: 'bg-gradient-to-r from-patio-stamp-soft to-patio-sun',
  emerald: 'bg-varsity-emerald',
  sky: 'bg-gradient-to-r from-sky-600 to-varsity-emerald',
  amber: 'bg-patio-sun'
} as const;

/** Barra de progreso con semántica de `progressbar`; el relleno es decorativo y el porcentaje siempre va también en texto a su lado. */
export function ProgressBar({ pct, label, tone = 'brand', size = 'md', className }: ProgressBarProps) {
  const value = Math.min(100, Math.max(0, Math.round(pct)));
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} className={clsx('w-full overflow-hidden rounded-full bg-patio-rule', size === 'lg' ? 'h-3.5' : 'h-3', className)}>
      <div className={clsx('h-full rounded-full motion-safe:transition-[width] motion-safe:duration-300', TONES[tone])} style={{ width: `${value}%` }} />
    </div>
  );
}
