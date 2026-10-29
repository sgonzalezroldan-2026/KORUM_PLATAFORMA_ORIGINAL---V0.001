import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import type { InitiativeStatus } from '@/types/korum.types';

const STATUS_STYLES: Record<InitiativeStatus, { icon: string; className: string }> = {
  BUDGETING: { icon: '📝', className: 'bg-slate-100 text-slate-900' },
  FUNDRAISING: { icon: '🌱', className: 'bg-emerald-100 text-emerald-950' },
  GOAL_REACHED: { icon: '🎉', className: 'bg-amber-100 text-amber-950' },
  CLOSED: { icon: '✅', className: 'bg-varsity-navy text-varsity-ivory' },
  EXPIRED: { icon: '⌛', className: 'bg-orange-100 text-orange-950' },
  RESIZE_VOTING: { icon: '🗳️', className: 'bg-indigo-100 text-indigo-950' },
  REFUNDING: { icon: '↩️', className: 'bg-sky-100 text-sky-950' },
  REFUNDED: { icon: '🧾', className: 'bg-slate-200 text-slate-900' },
  CANCELLED: { icon: '✖️', className: 'bg-red-100 text-red-950' }
};

export interface StatusBadgeProps {
  status: InitiativeStatus;
  className?: string;
}

/** Estado de una iniciativa. Siempre lleva texto además del icono y del color (WCAG 1.4.1). */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  const t = useTranslations('status.initiative');
  const style = STATUS_STYLES[status];

  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold', style.className, className)} data-status={status}>
      <span aria-hidden="true">{style.icon}</span>
      <span>{t(status)}</span>
    </span>
  );
}
