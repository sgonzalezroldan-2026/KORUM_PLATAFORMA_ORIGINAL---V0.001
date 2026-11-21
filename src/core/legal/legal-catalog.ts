/**
 * Catálogo de los textos legales de KORUM (Sprint 5.10a, `L-057`). Funciones puras que comparten la consola, las páginas públicas, la semilla y las pruebas:
 *
 * - **Qué documentos hay** (los nueve de la SESIÓN T1, `docs/legal/README.md` §1 y §3) y en qué ruta pública se publica cada uno.
 * - **Marcas `[[…]]`**: los datos de la empresa que rellena el promotor en la consola (`platform.company`), que se sustituyen al pintar la página.
 * - **Enlaces entre documentos**: los textos enlazan a los archivos de `docs/legal/` (`politica-de-privacidad.md`); al pintarlos se convierten en la ruta
 *   pública. Los documentos internos (tabla de plazos, evaluación de impacto, registro de actividades) **no se enlazan** desde una página pública.
 * - **Notas internas**: el recuadro inicial de cada archivo (las líneas `>` antes de la primera raya) no se publica.
 */

export const LEGAL_DOCUMENTS = [
  'terminos',
  'condiciones-entradas-y-vales',
  'condiciones-aportacion-mensual',
  'condiciones-entidades',
  'condiciones-comercios',
  'contrato-de-encargo',
  'privacidad',
  'cookies',
  'aviso-legal'
] as const;
export const LEGAL_LOCALES = ['es', 'ca', 'en'] as const;
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];
export type LegalLocale = (typeof LEGAL_LOCALES)[number];

/** Idioma del que salen los demás: si un texto aún no está traducido, se enseña y se acepta el castellano (decisión del promotor, 2026-11-21). */
export const LEGAL_BASE_LOCALE: LegalLocale = 'es';

/** Clave del ajuste de un texto en la consola (`legal.{documento}.{idioma}`), con el documento y el idioma como grupos 1 y 2. */
export const LEGAL_KEY_PATTERN = new RegExp(`^legal\\.(${LEGAL_DOCUMENTS.join('|')})\\.(${LEGAL_LOCALES.join('|')})$`);

export const isLegalDocument = (value: unknown): value is LegalDocument => typeof value === 'string' && (LEGAL_DOCUMENTS as readonly string[]).includes(value);
export const isLegalLocale = (value: unknown): value is LegalLocale => typeof value === 'string' && (LEGAL_LOCALES as readonly string[]).includes(value);

interface LegalDocumentInfo {
  /** Ruta pública, sin idioma. */
  path: string;
  /** Archivo de `docs/legal/` del que sale el texto (y al que apuntan los enlaces entre documentos). */
  sourceFile: string;
}

export const LEGAL_DOCUMENT_INFO: Readonly<Record<LegalDocument, LegalDocumentInfo>> = {
  terminos: { path: '/condiciones', sourceFile: 'condiciones-generales.md' },
  'condiciones-entradas-y-vales': { path: '/condiciones/entradas-y-vales', sourceFile: 'condiciones-entradas-y-vales.md' },
  'condiciones-aportacion-mensual': { path: '/condiciones/aportacion-mensual', sourceFile: 'condiciones-aportacion-mensual.md' },
  'condiciones-entidades': { path: '/condiciones/entidades', sourceFile: 'condiciones-entidades.md' },
  'condiciones-comercios': { path: '/condiciones/comercios', sourceFile: 'condiciones-comercios.md' },
  'contrato-de-encargo': { path: '/contrato-de-encargo', sourceFile: 'contrato-de-encargo.md' },
  privacidad: { path: '/privacidad', sourceFile: 'politica-de-privacidad.md' },
  cookies: { path: '/cookies', sourceFile: 'politica-de-cookies.md' },
  'aviso-legal': { path: '/aviso-legal', sourceFile: 'aviso-legal.md' }
};

export const legalPathOf = (document: LegalDocument): string => LEGAL_DOCUMENT_INFO[document].path;

/** Las condiciones de `/condiciones/{tipo}`: el tipo de la URL y su documento. */
export const CONDITIONS_BY_SLUG: Readonly<Record<string, LegalDocument>> = {
  'entradas-y-vales': 'condiciones-entradas-y-vales',
  'aportacion-mensual': 'condiciones-aportacion-mensual',
  entidades: 'condiciones-entidades',
  comercios: 'condiciones-comercios'
};

/** Los textos que aceptan las entidades: una versión nueva se avisa a quienes firman y se les aplica a los 30 días (decisión 54; contrato de encargo, cláusulas 10 y 17). */
export const ENTITY_NOTICE_DOCUMENTS: readonly LegalDocument[] = ['condiciones-entidades', 'contrato-de-encargo'];
export const ENTITY_NOTICE_DAYS = 30;

/**
 * Cambio importante de la política de privacidad (Sprint 5.10b, política §13; decisión 90): el único texto que lo admite, y cuántos días se avisa en una franja fija de
 * *Mi cuenta* y del panel de la entidad (además del email a todas las cuentas).
 */
export const IMPORTANT_CHANGE_DOCUMENT: LegalDocument = 'privacidad';
export const PRIVACY_CHANGE_NOTICE_DAYS = 30;

/** El único texto que admite un cambio urgente: la lista de proveedores del contrato de encargo (Anexo III; cláusula 10; decisión 58). */
export const URGENT_DOCUMENT: LegalDocument = 'contrato-de-encargo';

/** Los textos que acepta la entidad en el alta (primeras capas §4). */
export const REGISTRATION_DOCUMENTS = ['condiciones-entidades', 'contrato-de-encargo'] as const;

/**
 * Desde cuándo se aplica una versión a quien ya había aceptado la anterior: al momento, salvo los textos de las entidades cuando sustituyen a otra versión
 * (30 días). La excepción es una **urgencia** del contrato de encargo (un proveedor que deja de prestar el servicio o un problema de seguridad, decisión 58):
 * se aplica al momento y se avisa igual.
 */
export function effectiveDateFor(document: LegalDocument, publishedAt: Date, replacesAnother: boolean, urgent = false): Date {
  if (!replacesAnother || !ENTITY_NOTICE_DOCUMENTS.includes(document) || (urgent && document === URGENT_DOCUMENT)) return publishedAt;
  return new Date(publishedAt.getTime() + ENTITY_NOTICE_DAYS * 24 * 3600 * 1000);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Marcas de los datos de la empresa
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Lo que sustituye cada marca: un campo de `platform.company` o el dominio de la web (`NEXT_PUBLIC_APP_URL`). */
export const LEGAL_MARKERS = {
  'RAZÓN SOCIAL': 'legalName',
  NIF: 'taxId',
  'DOMICILIO SOCIAL': 'address',
  'EMAIL DE SOPORTE': 'supportEmail',
  'EMAIL DE PRIVACIDAD': 'privacyEmail',
  'DATOS REGISTRALES': 'registryData',
  DOMINIO: 'domain'
} as const;
export type LegalMarkerValues = Partial<Record<(typeof LEGAL_MARKERS)[keyof typeof LEGAL_MARKERS], string>>;

const MARKER = /\[\[([^\]\n]{1,40})\]\]/g;

/** Marcas que el texto usa y que no existen: un texto con una marca mal escrita no se publica (la página enseñaría los corchetes). */
export function unknownMarkers(markdown: string): string[] {
  const found = [...markdown.matchAll(MARKER)].map((match) => match[1]!).filter((name) => !(name in LEGAL_MARKERS));
  return [...new Set(found)];
}

/** Marcas del texto que no tienen dato: un texto así no se publica (la página diría «dato pendiente» donde la ley pide el dato). */
export function missingMarkers(markdown: string, values: LegalMarkerValues): string[] {
  const missing = [...markdown.matchAll(MARKER)].map((match) => match[1]!).filter((name) => name in LEGAL_MARKERS && !values[LEGAL_MARKERS[name as keyof typeof LEGAL_MARKERS]]?.trim());
  return [...new Set(missing)];
}

/** Sustituye cada marca por su dato. Un dato que aún no está en la consola se enseña como `missing` («dato pendiente»), nunca con los corchetes. */
export function fillMarkers(markdown: string, values: LegalMarkerValues, missing: string): string {
  return markdown.replace(MARKER, (whole, name: string) => {
    if (!(name in LEGAL_MARKERS)) return whole;
    const value = values[LEGAL_MARKERS[name as keyof typeof LEGAL_MARKERS]]?.trim();
    return value ? value : missing;
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Enlaces
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export type LegalLink =
  | { kind: 'document'; document: LegalDocument; hash: string }
  | { kind: 'page'; path: string }
  | { kind: 'external'; href: string }
  /** Un documento interno o un enlace que no se reconoce: se pinta solo el texto. */
  | { kind: 'text' };

const BY_SOURCE_FILE: ReadonlyMap<string, LegalDocument> = new Map(LEGAL_DOCUMENTS.map((document) => [LEGAL_DOCUMENT_INFO[document].sourceFile, document]));

/** Adónde lleva un enlace del texto. Solo se admiten documentos del catálogo, rutas propias (`/precios`), `https:` y `mailto:`. */
export function resolveLegalLink(href: string): LegalLink {
  const target = href.trim();
  const file = /^(?:\.\/)?([a-z0-9-]+\.md)(#[a-z0-9-]+)?$/i.exec(target);
  if (file) {
    const document = BY_SOURCE_FILE.get(file[1]!.toLowerCase());
    return document ? { kind: 'document', document, hash: file[2] ?? '' } : { kind: 'text' };
  }
  if (/^\/(?!\/)[a-z0-9\-/]*(?:#[a-z0-9-]+)?$/i.test(target)) return { kind: 'page', path: target };
  if (/^https:\/\/[^\s<>"']+$/i.test(target) || /^mailto:[^\s<>"']+$/i.test(target)) return { kind: 'external', href: target };
  return { kind: 'text' };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Archivos de docs/legal
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * El texto que se publica de un archivo de `docs/legal/`: el título (`# …`) y todo lo que va después de la primera raya (`---`). Las notas del recuadro inicial,
 * que son internas, se quitan.
 */
export function publishableMarkdown(fileText: string): string {
  const lines = fileText.replace(/\r\n/g, '\n').split('\n');
  const rule = lines.findIndex((line) => line.trim() === '---');
  if (rule < 0) return fileText.trim();
  const title = lines.slice(0, rule).find((line) => /^# /.test(line));
  const body = lines.slice(rule + 1).join('\n').trim();
  return title ? `${title}\n\n${body}` : body;
}

/** La versión que declara el recuadro de un archivo (`**Versión:** 2026-11-20`, o `2026-11-20.1` si hay otra del mismo día), o `null`. */
export function declaredVersion(fileText: string): string | null {
  return /\*\*Versión:\*\*\s*(\d{4}-\d{2}-\d{2}(?:\.[1-9]\d{0,2})?)/.exec(fileText)?.[1] ?? null;
}
