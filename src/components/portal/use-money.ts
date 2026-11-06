import { useLocale } from 'next-intl';
import { formatCents, type MoneyLocale } from '@/core/finance/money';
import { isLocale } from '@/i18n/routing';

/** Formateador de importes con el idioma activo, para componer frases con importes dentro (`{raised} de {goal}`). Siempre pasa por `formatCents`. */
export function useMoney(): (cents: number) => string {
  const current = useLocale();
  const locale: MoneyLocale = isLocale(current) ? current : 'es';
  return (cents: number) => formatCents(cents, locale);
}
