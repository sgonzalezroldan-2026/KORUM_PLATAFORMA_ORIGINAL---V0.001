import { createTranslator } from 'next-intl';
import { formatCents } from '@/core/finance/money';
import caMessages from '../../../../messages/ca.json';
import enMessages from '../../../../messages/en.json';
import esMessages from '../../../../messages/es.json';
import type { TemplateContext, Translate } from './email-content';

/**
 * Traductor y formateadores de los emails, fuera de cualquier petición web. Usa los mismos catálogos (`messages/{es,ca,en}.json`,
 * espacio `email`) y el mismo formato ICU que la aplicación. Una clave que falta **lanza**: un email con «email.receipt.title» en el
 * asunto es peor que un email que no sale (y el test de catálogos ya garantiza que las tres lenguas tienen las mismas claves).
 */

const MESSAGES = { es: esMessages, ca: caMessages, en: enMessages } as const;
export type EmailLocale = keyof typeof MESSAGES;

const TIME_ZONE = 'Europe/Madrid';

export function createEmailTranslator(locale: EmailLocale): Translate {
  const translator = createTranslator({
    locale,
    messages: MESSAGES[locale],
    namespace: 'email',
    onError: (error) => {
      throw error;
    },
    getMessageFallback: ({ namespace, key }) => {
      throw new Error(`Falta la traducción ${namespace ?? ''}.${key} (${locale})`);
    }
  }) as unknown as (key: string, values?: Record<string, string | number>) => string;
  return (key, values) => translator(key, values);
}

/** El inglés se escribe en ortografía británica (organisation), así que las fechas también (19 December 2026). */
const DATE_LOCALE: Record<EmailLocale, string> = { es: 'es', ca: 'ca', en: 'en-GB' };

export function createEmailFormatters(locale: EmailLocale): Pick<TemplateContext, 'formatMoney' | 'formatDate' | 'formatDateTime'> {
  const dateFormat = new Intl.DateTimeFormat(DATE_LOCALE[locale], { dateStyle: 'long', timeZone: TIME_ZONE });
  const dateTimeFormat = new Intl.DateTimeFormat(DATE_LOCALE[locale], { dateStyle: 'long', timeStyle: 'short', timeZone: TIME_ZONE });
  const toDate = (value: Date | string) => (typeof value === 'string' ? new Date(value) : value);
  return {
    formatMoney: (cents) => formatCents(cents, locale),
    formatDate: (value) => dateFormat.format(toDate(value)),
    formatDateTime: (value) => dateTimeFormat.format(toDate(value))
  };
}

/** URL absoluta de una ruta de la aplicación. El castellano va sin prefijo; el catalán y el inglés, con `/ca` y `/en` (Regla 01 §4). */
export function buildPublicUrl(appUrl: string, locale: EmailLocale, path: string): string {
  const prefix = locale === 'es' ? '' : `/${locale}`;
  return `${appUrl.replace(/\/+$/, '')}${prefix}${path.startsWith('/') ? path : `/${path}`}`;
}
