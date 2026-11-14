import type { AbstractIntlMessages } from 'next-intl';

/**
 * Qué secciones del catálogo de textos llegan al **navegador** en cada zona (Sprint 5.5a, QA-X01 y auditoría de seguridad). Los componentes de
 * servidor leen el catálogo entero en el servidor; el proveedor del navegador solo necesita lo que usan las piezas que corren en él. Antes se
 * enviaba el catálogo completo del idioma (unos 400 KB sin comprimir) dentro de cada página y de cada precarga de enlace, también los textos
 * internos del panel y de la consola a cualquier visitante.
 *
 * - **Pública** (marketing, portal de la entidad, errores): lo de sus piezas interactivas. El proveedor raíz (`[locale]/layout.tsx`).
 * - **Acceso, cuenta, panel (con su portería y las firmas) y consola**: lo público más lo suyo, en su `layout` (`PrivateIntlProvider`).
 * - **Galería de desarrollo** (solo en demostración): todo menos los emails.
 *
 * Si una pieza empieza a usar otra sección con `useTranslations`, hay que añadirla a su zona: sin ella el navegador registra un error de traducción
 * (las E2E exigen 0 errores de consola). Un componente **sin** `'use client'` también corre en el navegador si lo monta uno que sí lo es (el logotipo
 * dentro de un diálogo); por eso `tests/unit/client-messages.spec.ts` sigue las importaciones desde cada zona y revisa todo lo que alcanza.
 */
export const PUBLIC_CLIENT_SECTIONS = ['account', 'auth', 'brand', 'calculator', 'common', 'cookies', 'demo', 'error', 'finder', 'forbidden', 'languageSwitcher', 'nav', 'notFound', 'portal', 'status', 'ui'] as const;

/** Lo que añade cada zona privada a lo público. */
export const ZONE_EXTRA_SECTIONS = {
  auth: ['registration'],
  account: ['hucha'],
  dashboard: ['gate', 'ideas', 'panel'],
  admin: ['admin']
} as const;

export type ClientZone = keyof typeof ZONE_EXTRA_SECTIONS | 'dev';

/** Secciones que solo usa el servidor (las plantillas de email): nunca se envían al navegador. */
export const SERVER_ONLY_SECTIONS = ['email'] as const;

function pick(messages: AbstractIntlMessages, keep: (section: string) => boolean): AbstractIntlMessages {
  return Object.fromEntries(Object.entries(messages).filter(([section]) => keep(section)));
}

/** Secciones que recibe el navegador en una zona (`public` para el proveedor raíz). */
export function clientSectionsFor(zone: ClientZone | 'public'): ReadonlySet<string> | 'ALL_BUT_SERVER_ONLY' {
  if (zone === 'dev') return 'ALL_BUT_SERVER_ONLY';
  if (zone === 'public') return new Set<string>(PUBLIC_CLIENT_SECTIONS);
  return new Set<string>([...PUBLIC_CLIENT_SECTIONS, ...ZONE_EXTRA_SECTIONS[zone]]);
}

export function clientMessagesFor(zone: ClientZone | 'public', messages: AbstractIntlMessages): AbstractIntlMessages {
  const sections = clientSectionsFor(zone);
  if (sections === 'ALL_BUT_SERVER_ONLY') {
    const blocked = new Set<string>(SERVER_ONLY_SECTIONS);
    return pick(messages, (section) => !blocked.has(section));
  }
  return pick(messages, (section) => sections.has(section));
}

export const publicClientMessages = (messages: AbstractIntlMessages): AbstractIntlMessages => clientMessagesFor('public', messages);
