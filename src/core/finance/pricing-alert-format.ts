import { formatBps, formatCents, type MoneyLocale } from './money';
import type { PricingAlert } from './pricing-health';

/**
 * Cifras de un aviso de precios listas para su texto (`admin.pricingHealth.message.<código>`): los importes en céntimos (`…Cents`) salen
 * formateados con el idioma, los puntos básicos (`…Bps`) como porcentaje y el resto tal cual. Cada importe lleva además su valor sin
 * formatear en `…CentsRaw`, para que el texto decida con un plural (`{lossCentsRaw, plural, =0 {…} other {…}}`).
 */
export function pricingMessageValues(alert: Pick<PricingAlert, 'params'>, locale: MoneyLocale): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(alert.params)) {
    if (key.endsWith('Cents')) {
      values[key] = formatCents(value, locale);
      values[`${key}Raw`] = value;
    } else if (key.endsWith('Bps')) values[key] = formatBps(value, locale);
    else values[key] = value;
  }
  return values;
}
