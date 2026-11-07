import { formatCents } from '@/core/finance/money';
import type { PersonalDataExport } from './personal-data-export';

/**
 * Versión legible en PDF de la exportación de datos (QA-PRIV01). PDF 1.4 escrito a mano, sin dependencias: texto en Helvetica con la
 * codificación WinAnsi (cubre castellano, catalán, inglés y el símbolo €), A4 y varias páginas. Todos los textos salen del catálogo de
 * traducción (`privacy.export.*`) a través de `t`; aquí solo hay maquetación.
 */

export type ExportTranslator = (key: string, values?: Record<string, string>) => string;
export type ExportLocale = 'es' | 'ca' | 'en';

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 50;
const LINE_CHARS = 98;
const STYLE = { title: { font: 'F2', size: 16, leading: 24 }, heading: { font: 'F2', size: 11, leading: 18 }, body: { font: 'F1', size: 9, leading: 12 } } as const;
type Style = keyof typeof STYLE;
interface Line {
  style: Style;
  text: string;
}

/** Caracteres de Windows-1252 fuera de Latin-1. El resto de lo que no es WinAnsi se sustituye por «?». */
const CP1252: Record<string, number> = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };

function toWinAnsi(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0) ?? 0x3f;
    if (CP1252[char] !== undefined) bytes.push(CP1252[char]);
    // Tabulador y espacios finos o duros que `Intl` pone en fechas e importes.
    else if (code === 0x09 || code === 0x202f || code === 0x2009) bytes.push(0x20);
    else if (code >= 0x20 && code <= 0xff && !(code >= 0x7f && code <= 0x9f)) bytes.push(code);
    else bytes.push(0x3f);
  }
  return bytes;
}

/** Cadena literal de PDF: `(`, `)` y `\` se escapan; los bytes altos van en octal para que el fichero sea ASCII puro. */
function pdfString(text: string): string {
  return `(${toWinAnsi(text)
    .map((byte) => (byte === 0x28 || byte === 0x29 || byte === 0x5c ? `\\${String.fromCharCode(byte)}` : byte < 0x80 ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, '0')}`))
    .join('')})`;
}

function wrap(text: string, width = LINE_CHARS): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const chunks = word.length > width ? (word.match(new RegExp(`.{1,${width}}`, 'g')) ?? [word]) : [word];
    for (const chunk of chunks) {
      if (current && current.length + 1 + chunk.length > width) {
        lines.push(current);
        current = chunk;
      } else current = current ? `${current} ${chunk}` : chunk;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function layout(data: PersonalDataExport, t: ExportTranslator, locale: ExportLocale): Line[] {
  const date = (value: string | null) => (value ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' }).format(new Date(value)) : '—');
  const money = (cents: number) => formatCents(cents, locale);
  const yesNo = (value: boolean) => t(value ? 'yes' : 'no');
  const translated = (group: string, code: string) => {
    const text = t(`${group}.${code}`);
    return text === `${group}.${code}` ? code : text;
  };
  const lines: Line[] = [{ style: 'title', text: t('title') }, ...wrap(t('intro')).map((text) => ({ style: 'body' as const, text })), { style: 'body', text: t('generatedAt', { date: date(data.generatedAt) }) }];
  const section = (key: string, records: Array<Array<[string, string]>>) => {
    lines.push({ style: 'heading', text: t(`sections.${key}`) });
    if (records.length === 0) lines.push({ style: 'body', text: t('empty') });
    for (const fields of records) {
      for (const text of wrap(fields.map(([label, value]) => `${t(`fields.${label}`)}: ${value || '—'}`).join(' · '))) lines.push({ style: 'body', text });
      lines.push({ style: 'body', text: '' });
    }
  };
  const { account } = data;
  section('account', [
    [['name', account.name], ['email', account.email], ['locale', account.locale], ['taxId', account.taxId ?? ''], ['province', account.provinceCode ?? ''], ['postalCode', account.postalCode ?? '']],
    [['createdAt', date(account.createdAt)], ['lastActiveAt', date(account.lastActiveAt)], ['twoFactor', yesNo(account.twoFactorEnabled)]]
  ]);
  section('contributions', data.contributions.map((row) => [
    ['date', date(row.createdAt)], ['organization', row.organization], ['initiative', row.initiative], ['type', translated('types', row.type)], ['status', translated('statuses', row.status)],
    ['amount', money(row.amountCents)], ['guarantee', money(row.guaranteeContributionCents)], ['charged', money(row.totalChargedCents)], ['refunded', money(row.refundedCents)],
    ['group', row.group ?? ''], ['donorName', row.donorFullName ?? ''], ['taxId', row.donorTaxId ?? ''], ['province', row.donorProvinceCode ?? ''], ['asGuest', yesNo(row.asGuest)]
  ]));
  section('tickets', data.tickets.map((row) => [['serial', row.serialCode], ['initiative', row.initiative], ['quantity', String(row.quantity)], ['checkedIn', String(row.checkedInCount)], ['raffleNumbers', row.raffleNumbers.join(', ')], ['revoked', date(row.revokedAt)]]));
  section('consents', data.consents.map((row) => [['date', date(row.createdAt)], ['purpose', translated('purposes', row.purpose)], ['granted', yesNo(row.granted)], ['policyVersion', row.policyVersion], ['source', row.source]]));
  section('privacyRequests', data.privacyRequests.map((row) => [['date', date(row.createdAt)], ['type', translated('requestTypes', row.type)], ['status', translated('requestStatuses', row.status)], ['dueAt', date(row.dueAt)], ['completedAt', date(row.completedAt)]]));
  section('memberships', data.memberships.map((row) => [['organization', row.organization], ['role', row.roleLabel ?? row.role], ['date', date(row.since)]]));
  section('ideaSignatures', data.ideaSignatures.map((row) => [['date', date(row.createdAt)], ['idea', row.idea], ['status', row.status], ['accountOrder', String(row.accountOrder)]]));
  section('devices', data.devices.map((row) => [['firstSeen', date(row.firstSeenAt)], ['lastSeen', date(row.lastSeenAt)], ['accountOrder', String(row.accountOrder)], ['fingerprint', yesNo(row.fingerprintStored)]]));
  section('savedCards', data.savedCards.map((row) => [['card', `${row.brand ?? ''} ${row.last4 ? `•••• ${row.last4}` : ''}`.trim()], ['expires', row.expires ?? ''], ['date', date(row.createdAt)], ['revoked', date(row.revokedAt)]]));
  section('passkeys', data.passkeys.map((row) => [['name', row.name ?? ''], ['date', date(row.createdAt)], ['synced', yesNo(row.synced)]]));
  section('notifications', data.notifications.map((row) => [['date', date(row.createdAt)], ['template', row.template], ['status', translated('emailStatuses', row.status)], ['completedAt', date(row.sentAt)]]));
  section('supportTickets', data.supportTickets.map((row) => [['date', date(row.createdAt)], ['serial', row.ticketCode], ['subject', row.subject], ['message', row.message], ['reply', row.reply ?? ''], ['status', row.status]]));
  section('monthlyPledges', data.monthlyPledges.map((row) => [['organization', row.organization ?? ''], ['monthly', money(row.monthlyAmountCents)], ['progress', `${row.executedMonths}/${row.totalMonths}`], ['active', yesNo(row.active)]]));
  return lines;
}

function paginate(lines: Line[]): Line[][] {
  const pages: Line[][] = [[]];
  let used = 0;
  for (const line of lines) {
    const leading = STYLE[line.style].leading;
    if (used + leading > PAGE_HEIGHT - 2 * MARGIN && pages[pages.length - 1]!.length > 0) {
      pages.push([]);
      used = 0;
    }
    pages[pages.length - 1]!.push(line);
    used += leading;
  }
  return pages;
}

function contentStream(lines: Line[]): string {
  const parts = ['BT'];
  let y = PAGE_HEIGHT - MARGIN;
  for (const line of lines) {
    const style = STYLE[line.style];
    y -= style.leading;
    parts.push(`/${style.font} ${style.size} Tf`, `1 0 0 1 ${MARGIN} ${y} Tm`, `${pdfString(line.text)} Tj`);
  }
  parts.push('ET');
  return parts.join('\n');
}

export function renderPersonalDataPdf(data: PersonalDataExport, t: ExportTranslator, locale: ExportLocale): Uint8Array {
  const pages = paginate(layout(data, t, locale));
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  const pageIds = pages.map((_, index) => 5 + index * 2);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  for (const [index, page] of pages.entries()) {
    const stream = contentStream(page);
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[index]! + 1} 0 R >>`);
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // El contenido es ASCII (los bytes altos van en octal), así que la longitud en caracteres coincide con la de bytes.
  return new TextEncoder().encode(pdf);
}
