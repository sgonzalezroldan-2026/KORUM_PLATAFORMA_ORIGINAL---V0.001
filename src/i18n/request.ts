import { getRequestConfig } from 'next-intl/server';
import spanishMessages from '../../messages/es.json';
import { isLocale, routing } from './routing';

/** Marca visible de una clave sin traducir: los tests E2E fallan si aparece en pantalla (QA-C05). */
export const MISSING_MESSAGE_MARK = '__MISSING__';

/** Texto en castellano de una clave (`namespace.clave`), o cadena vacía si tampoco existe. */
function spanishFallback(path: string): string {
  const found = path.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), spanishMessages);
  return typeof found === 'string' ? found : '';
}

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = isLocale(requested) ? requested : routing.defaultLocale;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    getMessageFallback: ({ namespace, key }) => {
      const path = `${namespace ? `${namespace}.` : ''}${key}`;
      // En desarrollo y en las pruebas la clave sin traducir se ve (y falla el E2E); en producción nadie ve una clave técnica.
      return process.env.NODE_ENV === 'production' ? spanishFallback(path) : `${MISSING_MESSAGE_MARK}:${path}`;
    },
    onError: (error) => {
      if (process.env.NODE_ENV !== 'production') console.error(error.message);
    }
  };
});
