import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

/** Bloque de carga con la forma del contenido (nunca un spinner a pantalla completa). Decorativo para lectores de pantalla. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={clsx('animate-skeleton rounded-md bg-patio-rule', className)} />;
}

/** Párrafo de carga: `lines` líneas, la última más corta. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={clsx('space-y-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={clsx('h-4', index === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

/**
 * Envuelve esqueletos para que los lectores de pantalla sepan que se está cargando: anuncia «Cargando…» una sola vez
 * (`role="status"`) y marca la zona como ocupada. Los esqueletos de dentro siguen siendo decorativos.
 */
export function LoadingRegion({ children, className }: { children: ReactNode; className?: string }) {
  const t = useTranslations('common');

  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{t('loading')}</span>
      {children}
    </div>
  );
}
