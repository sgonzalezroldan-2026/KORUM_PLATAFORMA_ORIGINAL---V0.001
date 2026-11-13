import type { SecretKey } from '@/services/settings/setting-definitions';

/**
 * Modelo puro de `/admin/ajustes` (Sprint 5.4): qué ajustes lleva cada bloque de la pantalla, de qué tipo es cada campo y cómo se comparan las versiones de los
 * textos legales. Lo comparten la pantalla y el servidor: el servidor solo acepta, por bloque, los campos de esta lista (un campo de otro bloque o inventado se
 * rechaza), así que lo que el navegador envía nunca decide qué ajuste se toca.
 */

export const SETTINGS_SECTIONS = ['pagos', 'email', 'facturacion', 'hucha', 'autoimpulso', 'seo', 'empresa', 'limites'] as const;
export type SectionId = (typeof SETTINGS_SECTIONS)[number];
export const isSectionId = (value: unknown): value is SectionId => typeof value === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(value);

export type FieldKind = 'text' | 'number' | 'select' | 'json';

export interface FieldSpec {
  /** Clave del ajuste en el catálogo (`setting-definitions.ts`). */
  key: string;
  kind: FieldKind;
  /** Solo `select`: valores admitidos. */
  options?: readonly string[];
  /** Solo `text`: teclado y autocompletado del campo. */
  inputMode?: 'text' | 'email' | 'numeric' | 'url';
  maxLength?: number;
}

/** Proveedor de email con adaptador. SMTP figura en el catálogo pero no tiene adaptador (Sprint 2.6): la consola no lo ofrece. */
export const EMAIL_PROVIDERS = ['brevo'] as const;
export const HUCHA_MODES = ['DISABLED', 'PLEDGE', 'REGULATED_WALLET'] as const;
export const DISCLOSURE_OPTIONS = ['SHOW', 'HIDE'] as const;

export const SECTION_FIELDS: Record<SectionId, readonly FieldSpec[]> = {
  pagos: [
    { key: 'paycomet.merchantCode', kind: 'text', maxLength: 40 },
    { key: 'paycomet.terminalId', kind: 'text', inputMode: 'numeric', maxLength: 10 },
    { key: 'paycomet.jetId', kind: 'text', maxLength: 80 },
    { key: 'paycomet.serverIp', kind: 'text', maxLength: 45 }
  ],
  email: [
    { key: 'email.provider', kind: 'select', options: EMAIL_PROVIDERS },
    { key: 'email.fromAddress', kind: 'text', inputMode: 'email', maxLength: 254 },
    { key: 'email.fromName', kind: 'text', maxLength: 80 },
    { key: 'email.replyTo', kind: 'text', inputMode: 'email', maxLength: 254 }
  ],
  facturacion: [
    { key: 'invoicing.provider', kind: 'text', maxLength: 60 },
    { key: 'invoicing.issuerNif', kind: 'text', maxLength: 20 },
    { key: 'invoicing.issuerName', kind: 'text', maxLength: 200 },
    { key: 'invoicing.series', kind: 'text', maxLength: 10 }
  ],
  hucha: [
    { key: 'hucha.mode', kind: 'select', options: HUCHA_MODES },
    { key: 'hucha.walletProvider', kind: 'text', maxLength: 60 }
  ],
  autoimpulso: [{ key: 'autoBoost.publicDisclosureDefault', kind: 'select', options: DISCLOSURE_OPTIONS }],
  seo: [
    { key: 'seo.aiCrawlers', kind: 'json' },
    { key: 'seo.verification.google', kind: 'text', maxLength: 200 },
    { key: 'seo.verification.bing', kind: 'text', maxLength: 200 }
  ],
  empresa: [{ key: 'platform.company', kind: 'json' }],
  limites: [{ key: 'raffle.extraRoundMinHours', kind: 'number', inputMode: 'numeric' }]
};

/** Secretos de cada bloque, para dibujar sus campos de «clave» (siempre de solo escritura). */
export const SECTION_SECRETS: Partial<Record<SectionId, readonly SecretKey[]>> = {
  pagos: ['paycomet.apiKey', 'paycomet.webhookSecret'],
  email: ['email.apiKey'],
  facturacion: ['invoicing.apiKey'],
  hucha: ['hucha.walletApiKey'],
  seo: ['seo.indexNowKey']
};

/** Secretos sin los que, con cobros de pruebas o reales, se para un servicio: no se quitan salvo que el servidor tenga una variable de respaldo. */
export const SECRET_REQUIRED_KEYS: readonly SecretKey[] = ['paycomet.apiKey', 'paycomet.webhookSecret', 'email.apiKey'];

/** Clave de texto de un campo en los catálogos de traducción (los puntos son anidación en `next-intl`). */
export const fieldI18nKey = (key: string): string => key.replaceAll('.', '_');

export const sectionFieldSpec = (section: SectionId, key: string): FieldSpec | undefined => SECTION_FIELDS[section].find((field) => field.key === key);

/**
 * Nombre de un rastreador: se escribe tal cual en una línea `User-agent:` de `robots.txt`, así que solo admite los caracteres de un nombre de producto (sin saltos de línea, espacios
 * ni `*`): un valor con un salto de línea colaría directivas propias en el fichero que leen todos los buscadores.
 */
export const CRAWLER_USER_AGENT = /^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/;

/** Código de verificación de Google Search Console o Bing Webmaster Tools: va dentro de una etiqueta `<meta>` de todas las páginas. */
export const SEARCH_VERIFICATION_TOKEN = /^[A-Za-z0-9_-]{8,200}$/;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Textos legales versionados
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export const LEGAL_DOCUMENTS = ['terminos', 'privacidad', 'cookies', 'aviso-legal'] as const;
export const LEGAL_LOCALES = ['es', 'ca', 'en'] as const;
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];
export type LegalLocale = (typeof LEGAL_LOCALES)[number];

export const isLegalDocument = (value: unknown): value is LegalDocument => typeof value === 'string' && (LEGAL_DOCUMENTS as readonly string[]).includes(value);
export const isLegalLocale = (value: unknown): value is LegalLocale => typeof value === 'string' && (LEGAL_LOCALES as readonly string[]).includes(value);
export const legalKeyOf = (document: LegalDocument, locale: LegalLocale) => `legal.${document}.${locale}` as const;

/** Forma canónica de una versión: la secuencia empieza en 1 y no lleva ceros a la izquierda (`.0` o `.01` serían la misma versión escrita de otra forma y esquivarían las comprobaciones). */
export const LEGAL_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}(?:\.[1-9]\d{0,2})?$/;
const VERSION = /^(\d{4})-(\d{2})-(\d{2})(?:\.([1-9]\d{0,2}))?$/;

/** Versión de un texto legal: la fecha de publicación (`AAAA-MM-DD`) y, si hay varias el mismo día, `.n`. Devuelve `null` si no tiene ese formato o la fecha no existe. */
export function parseLegalVersion(version: string): { date: string; sequence: number } | null {
  const match = VERSION.exec(version);
  if (!match) return null;
  const [, year, month, day, sequence] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return { date: `${year}-${month}-${day}`, sequence: sequence === undefined ? 0 : Number(sequence) };
}

/** Negativo si `a` es anterior a `b`, 0 si son la misma versión y positivo si es posterior. Una versión sin formato válido se trata como anterior a todas. */
export function compareLegalVersions(a: string, b: string): number {
  const left = parseLegalVersion(a);
  const right = parseLegalVersion(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  if (left.date !== right.date) return left.date < right.date ? -1 : 1;
  return left.sequence - right.sequence;
}

/** Fecha de hoy en España (`AAAA-MM-DD`): la versión de un texto es el día en que se publica, medido donde vive la entidad, no en UTC. */
export function legalToday(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Versión que se propone para un texto nuevo: hoy, o la siguiente del mismo día si ya hay una. */
export function nextLegalVersion(current: string | null, now: Date): string {
  const today = legalToday(now);
  if (current === null) return today;
  const parsed = parseLegalVersion(current);
  if (!parsed || parsed.date < today) return today;
  return `${parsed.date}.${parsed.sequence + 1}`;
}
