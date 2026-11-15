import { AUDIT_ACTION_PATTERN, isAuditCategory, type AuditCategory } from './audit-catalog';

/**
 * Filtros del visor de la auditoría tal como viajan en la dirección web (Sprint 5.8a). Son un formulario normal (`GET`): funcionan sin JavaScript y la página
 * se pinta siempre en el servidor. Aquí solo se valida la **forma** de cada valor; que la entidad, la persona o la iniciativa sean de quien mira lo decide
 * el servicio (la consulta de una entidad lleva siempre su `organizationId`). Lo que no encaja se ignora: un filtro mal escrito no rompe la página.
 *
 * El email de una persona **nunca** viaja aquí: la consola lo traduce a su identificador con una acción de servidor y redirige (`persona=<id>`), para que
 * no quede en el historial del navegador ni en los registros del servidor.
 */

export const AUDIT_QUERY_KEYS = { category: 'familia', action: 'accion', person: 'persona', organization: 'entidad', initiative: 'iniciativa', from: 'desde', to: 'hasta', before: 'antes' } as const;

export interface AuditQuery {
  category?: AuditCategory | 'unclassified';
  action?: string;
  personUserId?: string;
  organizationId?: string;
  initiativeId?: number;
  /** Días del calendario de España (`AAAA-MM-DD`), tal como se eligieron. */
  fromDay?: string;
  toDay?: string;
  before?: number;
}

const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_INT = 2_147_483_647;

type Raw = Record<string, string | string[] | undefined>;
const first = (raw: Raw, key: string): string => {
  const value = raw[key];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
};

const positiveInt = (text: string): number | undefined => {
  if (!/^[1-9]\d{0,9}$/.test(text)) return undefined;
  const value = Number(text);
  return value <= MAX_INT ? value : undefined;
};

/** Un día real del calendario (no `2026-02-31`), entre 2020 y 2100. */
export function isCalendarDay(text: string): boolean {
  const match = DAY.exec(text);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 2020 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function parseAuditQuery(raw: Raw, options: { allowUnclassified: boolean }): AuditQuery {
  const query: AuditQuery = {};
  const category = first(raw, AUDIT_QUERY_KEYS.category);
  if (isAuditCategory(category)) query.category = category;
  else if (category === 'unclassified' && options.allowUnclassified) query.category = 'unclassified';
  const action = first(raw, AUDIT_QUERY_KEYS.action);
  if (action.length <= 80 && AUDIT_ACTION_PATTERN.test(action)) query.action = action;
  const person = first(raw, AUDIT_QUERY_KEYS.person);
  if (IDENTIFIER.test(person)) query.personUserId = person;
  const organization = first(raw, AUDIT_QUERY_KEYS.organization);
  if (IDENTIFIER.test(organization)) query.organizationId = organization;
  const initiative = positiveInt(first(raw, AUDIT_QUERY_KEYS.initiative));
  if (initiative !== undefined) query.initiativeId = initiative;
  const from = first(raw, AUDIT_QUERY_KEYS.from);
  if (isCalendarDay(from)) query.fromDay = from;
  const to = first(raw, AUDIT_QUERY_KEYS.to);
  if (isCalendarDay(to)) query.toDay = to;
  const before = positiveInt(first(raw, AUDIT_QUERY_KEYS.before));
  if (before !== undefined) query.before = before;
  return query;
}

/** Cuántos filtros hay puestos (la paginación no cuenta). */
export const activeAuditFilters = (query: AuditQuery): number =>
  [query.category, query.action, query.personUserId, query.organizationId, query.initiativeId, query.fromDay, query.toDay].filter((value) => value !== undefined).length;

/** Desfase de la hora de España respecto a UTC en un instante dado, en minutos (60 en invierno, 120 en verano). */
function madridOffsetMinutes(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(instant);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** El instante en que empieza ese día en España (medianoche de Madrid), con `addDays` días después. */
export function madridDayStart(day: string, addDays = 0): Date {
  const match = DAY.exec(day);
  if (!match) throw new RangeError(`Día no válido: ${day}`);
  const midnightUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + addDays);
  // Se calcula el desfase en esa medianoche; si al aplicarlo se cruza un cambio de hora, se corrige una vez.
  const guess = new Date(midnightUtc - madridOffsetMinutes(new Date(midnightUtc)) * 60_000);
  return new Date(midnightUtc - madridOffsetMinutes(guess) * 60_000);
}

/** Intervalo `[from, to)` de los días elegidos: «hasta el día 14» incluye todo el día 14. */
export function auditDateRange(query: Pick<AuditQuery, 'fromDay' | 'toDay'>): { from?: Date; to?: Date } {
  return { ...(query.fromDay ? { from: madridDayStart(query.fromDay) } : {}), ...(query.toDay ? { to: madridDayStart(query.toDay, 1) } : {}) };
}

/** La dirección de la misma búsqueda con otros valores (para «ver anteriores» y «quitar filtros»). */
export function auditQueryString(query: AuditQuery, overrides: Partial<AuditQuery> = {}): string {
  const merged = { ...query, ...overrides };
  const params = new URLSearchParams();
  const set = (key: string, value: string | number | undefined) => {
    if (value !== undefined && value !== '') params.set(key, String(value));
  };
  set(AUDIT_QUERY_KEYS.category, merged.category);
  set(AUDIT_QUERY_KEYS.action, merged.action);
  set(AUDIT_QUERY_KEYS.person, merged.personUserId);
  set(AUDIT_QUERY_KEYS.organization, merged.organizationId);
  set(AUDIT_QUERY_KEYS.initiative, merged.initiativeId);
  set(AUDIT_QUERY_KEYS.from, merged.fromDay);
  set(AUDIT_QUERY_KEYS.to, merged.toDay);
  set(AUDIT_QUERY_KEYS.before, merged.before);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * Lo que cabe con holgura en un desplegable a 430 px (unos 318 px útiles) sin que el navegador corte el texto elegido. El texto entero va en `title`, pero
 * en un móvil no se ve: por eso lo recortado tiene que bastar para elegir.
 */
export const AUDIT_OPTION_MAX = 30;
const ELLIPSIS = '…';
/** Por debajo de esto no se busca el final de una palabra: se corta donde toque. */
const MIN_WORD_CUT = 12;

/**
 * Recorta por **palabras completas** (nunca a media palabra: «Documentación del titular rec…» no dice nada y dos opciones podían diferenciarse en una
 * letra). Los textos de las acciones empiezan por lo que las distingue, y `tests/unit/audit-catalog.spec.ts` comprueba que, recortadas así, no hay dos
 * iguales en ningún idioma.
 */
export function shortOption(text: string, max = AUDIT_OPTION_MAX): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  // Si el corte cae justo al final de una palabra, se queda entera; si no, se retrocede hasta el espacio anterior.
  const space = /\s/.test(text[max - 1] ?? '') ? cut.length : cut.lastIndexOf(' ');
  const head = (space >= MIN_WORD_CUT ? cut.slice(0, space) : cut).trimEnd().replace(/[\s·:,;(«“-]+$/u, '');
  return `${head}${ELLIPSIS}`;
}

/** Principio y final («AMPA del CEIP Nuestra… del Pilar»): para textos que empiezan igual y se distinguen por cómo acaban. */
function middleOption(text: string, max: number): string {
  if (text.length <= max) return text;
  const tailWords = text.split(/\s+/).slice(-2).join(' ');
  const tail = tailWords.length <= Math.floor(max / 2) ? tailWords : text.slice(-Math.floor(max / 3));
  const head = text.slice(0, Math.max(4, max - tail.length - 2)).trimEnd();
  const space = head.lastIndexOf(' ');
  return `${(space >= 4 ? head.slice(0, space) : head).replace(/[\s·:,;(«“-]+$/u, '')}${ELLIPSIS} ${tail}`;
}

/**
 * Recorta una lista de opciones escritas por la gente (nombres de entidades, de personas firmantes), que no se pueden redactar para que empiecen distinto:
 * si al recortar dos quedan iguales, esas se recortan por el medio, conservando el final; y si aun así coinciden, llevan un número delante. Nunca devuelve
 * dos textos iguales para dos opciones distintas.
 */
export function distinctShortOptions(texts: readonly string[], max = AUDIT_OPTION_MAX): string[] {
  const repeated = (values: readonly string[]) => {
    const seen = new Map<string, number>();
    for (const value of values) seen.set(value, (seen.get(value) ?? 0) + 1);
    return (value: string) => (seen.get(value) ?? 0) > 1;
  };
  let shown = texts.map((text) => shortOption(text, max));
  let clash = repeated(shown);
  shown = shown.map((value, index) => (clash(value) ? middleOption(texts[index]!, max) : value));
  clash = repeated(shown);
  let ordinal = 0;
  return shown.map((value, index) => {
    if (!clash(value)) return value;
    ordinal += 1;
    const prefix = `${ordinal}. `;
    return `${prefix}${shortOption(texts[index]!, max - prefix.length)}`;
  });
}

/** Palabras que no pueden quedar colgando justo antes de los puntos suspensivos («Canchas de…»), en los tres idiomas. */
const DANGLING = new Set([
  ...['y', 'e', 'o', 'u', 'ni', 'de', 'del', 'la', 'el', 'lo', 'los', 'las', 'un', 'una', 'unos', 'unas', 'su', 'sus', 'para', 'por', 'en', 'con', 'sin', 'sobre', 'entre', 'como', 'que', 'a', 'al'],
  ...['i', 'dels', 'les', 'els', 'uns', 'unes', 'per', 'pel', 'pels', 'amb', 'sense', 'des', 'com', 'seu', 'seva', 'seus', 'seves', "d'", "l'", 'd’', 'l’'],
  ...['and', 'or', 'of', 'the', 'an', 'for', 'in', 'on', 'at', 'to', 'by', 'from', 'with', 'about', 'its', 'our']
]);
/** Lo que no puede quedar justo delante de los puntos suspensivos: espacios y puntuación que abre o separa. */
const TRAILING = /[\s·:,;(«“\-–—&/+]+$/u;

/** Recorta un título, como `shortOption`, sin dejar al final un conector suelto. */
export function shortTitle(title: string, max: number): string {
  const short = shortOption(title, max);
  if (short === title) return short;
  let head = short.slice(0, -1).replace(TRAILING, '');
  for (;;) {
    const space = head.lastIndexOf(' ');
    if (space < 0 || !DANGLING.has(head.slice(space + 1).toLocaleLowerCase())) break;
    head = head.slice(0, space).replace(TRAILING, '');
  }
  return head ? `${head}${short.slice(-1)}` : short;
}
