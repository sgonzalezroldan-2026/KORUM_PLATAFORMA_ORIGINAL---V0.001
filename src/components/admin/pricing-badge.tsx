import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

/**
 * Insignia de la cabecera de la consola con los avisos de precios abiertos (sin aceptar). Lleva texto y número, no solo color; roja si alguno
 * es crítico. Con cero avisos no se pinta nada.
 */
export function PricingBadge({ open, openCritical }: { open: number; openCritical: number }) {
  const t = useTranslations('admin.pricingHealth');
  if (open === 0) return null;
  const tone = openCritical > 0 ? 'bg-red-100 text-red-950' : 'bg-amber-100 text-amber-950';

  return (
    <Link href="/admin#salud-de-precios" className={`inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-extrabold ${tone}`} data-testid="pricing-badge">
      <span aria-hidden="true">{openCritical > 0 ? '❗' : '⚠️'}</span>
      <span>{t('badge', { count: open })}</span>
    </Link>
  );
}
