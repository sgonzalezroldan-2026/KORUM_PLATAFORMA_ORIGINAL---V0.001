import clsx from 'clsx';
import { useLocale } from 'next-intl';
import { formatCents, type MoneyLocale } from '@/core/finance/money';
import { isLocale } from '@/i18n/routing';

export interface CurrencyTextProps {
  /** Importe en céntimos enteros (`2500` = `25,00 €`). */
  cents: number;
  className?: string;
}

/** Importe con la tipografía de zona de dinero (`Plus Jakarta Sans`, cifras tabulares) y el formato del idioma activo. */
export function CurrencyText({ cents, className }: CurrencyTextProps) {
  const current = useLocale();
  const locale: MoneyLocale = isLocale(current) ? current : 'es';

  return (
    <span className={clsx('font-corp tabular-nums whitespace-nowrap', className)} data-cents={cents}>
      {formatCents(cents, locale)}
    </span>
  );
}
