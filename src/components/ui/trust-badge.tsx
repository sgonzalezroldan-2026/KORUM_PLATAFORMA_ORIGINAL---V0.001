import clsx from 'clsx';
import type { ReactNode } from 'react';

export interface TrustBadgeProps {
  /** Emoji o icono decorativo. */
  icon?: string;
  tone?: 'navy' | 'emerald';
  className?: string;
  children: ReactNode;
}

/**
 * Etiqueta de confianza para zonas de dinero y garantías (capa 1 · `.korum-trust-vault`).
 * Es solo texto: no imita sellos oficiales ni de regulación (Regla 03 §4).
 */
export function TrustBadge({ icon, tone = 'navy', className, children }: TrustBadgeProps) {
  return (
    <span
      className={clsx(
        'korum-trust-vault inline-flex items-center gap-2 px-3 py-1.5 text-sm font-semibold text-varsity-navy',
        tone === 'emerald' && 'border-varsity-emerald',
        className
      )}
    >
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      <span className="text-start">{children}</span>
    </span>
  );
}
