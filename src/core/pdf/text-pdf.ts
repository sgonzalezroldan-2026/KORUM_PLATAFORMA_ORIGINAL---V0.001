/**
 * Escritor de PDF de texto, sin dependencias (Sprint 2.5, extraído en el 4.1 para compartirlo): PDF 1.4 escrito a mano, texto en Helvetica con
 * la codificación WinAnsi (cubre castellano, catalán, inglés y el símbolo €), A4 y varias páginas. Aquí solo hay maquetación: los textos los
 * pone quien llama, ya traducidos. Los emojis no existen en WinAnsi y salen como «?»: quien llama no debe ponerlos.
 */

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 50;
const LINE_CHARS = 98;
const STYLE = { title: { font: 'F2', size: 16, leading: 24 }, heading: { font: 'F2', size: 11, leading: 18 }, body: { font: 'F1', size: 9, leading: 12 } } as const;

export type PdfLineStyle = keyof typeof STYLE;
export interface PdfLine {
  style: PdfLineStyle;
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

/** Parte un texto en líneas de como máximo `width` caracteres, sin cortar palabras (salvo las que no caben en una línea). */
export function wrapPdfText(text: string, width = LINE_CHARS): string[] {
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

function paginate(lines: PdfLine[]): PdfLine[][] {
  const pages: PdfLine[][] = [[]];
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

function contentStream(lines: PdfLine[]): string {
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

/** Compone el PDF con esas líneas, repartidas en las páginas que hagan falta. */
export function renderLinesPdf(allLines: PdfLine[]): Uint8Array {
  const pages = paginate(allLines);
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
