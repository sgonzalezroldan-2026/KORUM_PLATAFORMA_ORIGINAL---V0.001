import { formatCents, type MoneyLocale } from '@/core/finance/money';
import { wrapPdfText, type PdfDocumentOptions, type PdfLine } from '@/core/pdf/text-pdf';
import type { DossierActor, DossierData } from './dossier-model';

/**
 * Hoja del expediente exportable (Sprint 5.8b): los textos que necesita (`DossierTexts`) y las piezas con las que se escribe cada línea (título, apartado,
 * párrafo y fila «rótulo: valor»), con los importes y las fechas en el idioma pedido. Qué se escribe lo decide `dossier-pdf.ts`.
 */

export interface DossierTexts {
  /** `audit.dossier.*` */
  t: (key: string, values?: Record<string, string | number>) => string;
  /** Texto llano de una acción de la auditoría (`audit.actions.*`). */
  action: (code: string) => string;
  /** Estado de una campaña (`status.initiative.*`). */
  status: (code: string) => string;
  /** Cargo de quien firma (`DIRECTOR`, `COSIGNER`). */
  role: (code: string) => string;
  /** Nombre de un tipo de objetivo de la auditoría; `null` si no tiene. */
  target: (type: string) => string | null;
  /** Motivo de un cambio de estado. */
  reason: (code: string) => string;
  /** Quién, cuando no es una persona firmante (`audit.actor.*`). */
  actor: (kind: Exclude<DossierActor['kind'], 'member'>) => string;
  /** Qué aviso es un email, en lenguaje llano y no por el código de su plantilla. */
  emailTemplate: (templateKey: string) => string;
}

export const DOSSIER_INDENT = '    ';
const WIDTH = 98;
/** Sangría de las líneas de continuación de una fila o de un elemento de lista. */
const HANG = '  ';

/**
 * El PDF se escribe en WinAnsi, que no tiene emojis ni flechas: en vez de dejar un «?» en el título de una campaña que los lleva, se quitan (y las flechas
 * se escriben con signos que sí existen).
 */
export const pdfSafeText = (text: string): string =>
  text
    .replace(/[←-⇿➔➡]/g, '->')
    .replace(/[\p{Extended_Pictographic}\u{fe0f}\u{200d}\u{1f3fb}-\u{1f3ff}]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

export class DossierSheet {
  readonly lines: PdfLine[] = [];
  /** El inglés del catálogo es británico: día antes que mes y reloj de 24 horas. */
  private readonly dateLocale: string;
  constructor(
    private readonly locale: MoneyLocale,
    readonly texts: DossierTexts
  ) {
    this.dateLocale = locale === 'en' ? 'en-GB' : locale;
  }

  money = (cents: number) => formatCents(cents, this.locale);
  /** Día, hora, minuto y segundo de España, siempre con dos cifras en la hora. */
  moment = (value: Date) =>
    new Intl.DateTimeFormat(this.dateLocale, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Madrid' }).format(value);
  /** Un día del calendario de España (`AAAA-MM-DD`). */
  day = (value: string) => new Intl.DateTimeFormat(this.dateLocale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00.000Z`));
  /** Solo el día de España de un instante: en el expediente de la entidad, lo que tiene que ver con una aportación nunca lleva su hora. */
  dayOf = (value: Date) => new Intl.DateTimeFormat(this.dateLocale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' }).format(value);
  /** Una fecha que puede faltar porque todavía no ha ocurrido (aprobar, enviar, cerrar). */
  momentOrNotYet = (value: Date | null) => (value ? this.moment(value) : this.texts.t('values.notYet'));
  yesNo = (value: boolean) => this.texts.t(value ? 'yes' : 'no');

  title(text: string) {
    for (const line of wrapPdfText(pdfSafeText(text), 54)) this.lines.push({ style: 'title', text: line });
  }
  heading(text: string) {
    this.lines.push({ style: 'body', text: '' });
    for (const line of wrapPdfText(pdfSafeText(text), 80)) this.lines.push({ style: 'heading', text: line });
  }
  /** Un párrafo corrido. */
  text(text: string) {
    for (const line of wrapPdfText(pdfSafeText(text), WIDTH)) this.lines.push({ style: 'body', text: line });
  }
  /** La frase que presenta una lista: no se parte entre dos páginas ni se queda al pie de una separada de su primera línea de datos. */
  intro(text: string) {
    for (const line of wrapPdfText(pdfSafeText(text), WIDTH)) this.lines.push({ style: 'body', text: line, keepWithNext: true });
  }
  /** Un valor del catálogo escrito en minúscula («enviada»), como valor de una fila «Estado:»: con mayúscula inicial, como los estados de una campaña. */
  capital = (text: string) => (text ? text.charAt(0).toLocaleUpperCase(this.dateLocale) + text.slice(1) : text);
  /** Una fila o un elemento de lista: si no cabe en una línea, las siguientes van sangradas para que se vea que continúan. */
  item(text: string, indent = '', keepWithNext = false) {
    const wrapped = wrapPdfText(pdfSafeText(text), WIDTH - indent.length - HANG.length);
    // Sus líneas no se reparten entre dos páginas; con `keepWithNext`, tampoco se separa de lo que sigue (una firma de su huella).
    wrapped.forEach((line, index) => this.lines.push({ style: 'body', text: `${indent}${index === 0 ? '' : HANG}${line}`, ...(index < wrapped.length - 1 || keepWithNext ? { keepWithNext: true } : {}) }));
  }
  row(labelKey: string, value: string) {
    this.item(`${this.texts.t(labelKey)}: ${value}`);
  }
  bullet(text: string, keepWithNext = false) {
    this.item(`- ${text}`, '', keepWithNext);
  }
  blank() {
    this.lines.push({ style: 'body', text: '' });
  }
}

/** Cada página lleva al pie la referencia del expediente y su número; un apartado nunca se queda solo al final de una hoja. */
export function dossierPdfOptions(data: DossierData, texts: DossierTexts): PdfDocumentOptions {
  return {
    footer: (page, total) => texts.t('footer', { reference: data.reference, page, total }),
    title: `${texts.t(`title.${data.kind}`)} · ${data.reference}`,
    keepHeadings: true
  };
}
