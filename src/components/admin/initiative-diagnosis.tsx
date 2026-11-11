import { useLocale, useTranslations } from 'next-intl';
import type { BiInitiativeRow } from '@/core/finance/bi-aggregate';
import { formatCents } from '@/core/finance/money';
import { isLocale } from '@/i18n/routing';

type Diagnosis = Pick<BiInitiativeRow, 'status' | 'isNegativeReturnAlert' | 'isProfitableSelfBoost' | 'netRevenueCents' | 'missingTo100Cents' | 'netProfitAfterBoostCents'>;

/**
 * Diagnóstico de rentabilidad de una iniciativa (Regla 02 §10). 🚨 si su neto al 100 % es negativo; 💎 si KORUM gana aportando lo que falta
 * (solo con lo ya cobrado más la comisión y el mantenimiento que se liquidan al completar la meta, sin el fee de patrocinio ya cobrado).
 * «Faltan X…» solo en las que están recaudando: en una vencida, en votación o devuelta no hay Auto-Impulso posible y su neto incluye
 * lo que KORUM conserva de todos modos. Siempre lleva texto, no solo color.
 */
export function InitiativeDiagnosis({ row }: { row: Diagnosis }) {
  const t = useTranslations('admin.diagnosis');
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const money = (cents: number) => formatCents(cents, locale);

  if (row.isNegativeReturnAlert) {
    return (
      <span className="inline-flex rounded-full border-2 border-red-700 bg-red-100 px-3 py-1 text-sm font-extrabold text-red-950" data-diagnosis="negative">
        {t('negative', { net: money(row.netRevenueCents) })}
      </span>
    );
  }
  if (row.isProfitableSelfBoost) {
    return (
      <span className="inline-flex rounded-full border-2 border-varsity-emerald bg-emerald-100 px-3 py-1 text-sm font-extrabold text-emerald-950" data-diagnosis="boost">
        {t('boost', { missing: money(row.missingTo100Cents), profit: money(row.netProfitAfterBoostCents) })}
      </span>
    );
  }
  if (row.missingTo100Cents === 0) return <span className="text-sm font-bold text-varsity-emerald">{t('complete')}</span>;
  if (row.status !== 'FUNDRAISING') return null;
  return <span className="text-sm text-ink-soft">{t('missing', { missing: money(row.missingTo100Cents), sign: row.netProfitAfterBoostCents > 0 ? 'gain' : row.netProfitAfterBoostCents < 0 ? 'loss' : 'flat', profit: money(Math.abs(row.netProfitAfterBoostCents)) })}</span>;
}
