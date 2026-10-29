import { defineRouting } from 'next-intl/routing';

export const LOCALES = ['es', 'ca', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: 'es',
  // El castellano va sin prefijo (/), el catalán y el inglés con él (/ca, /en).
  localePrefix: 'as-needed',
  // La URL decide el idioma: sin redirección por el idioma del navegador (buscadores y enlaces compartidos ven siempre
  // lo mismo) y sin cookie de idioma. La preferencia de una persona registrada se guarda en `User.locale`.
  localeDetection: false,
  localeCookie: false
});

export function isLocale(value: string | undefined): value is Locale {
  return LOCALES.includes(value as Locale);
}
