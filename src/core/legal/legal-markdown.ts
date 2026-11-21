/**
 * Lector del Markdown de los textos legales (Sprint 5.10a). Convierte el texto en bloques que la página pinta con elementos de React, **sin HTML**: un texto
 * con `<script>` o con un enlace `javascript:` se enseña como texto, nunca se ejecuta (los textos los escribe el Super-Admin, pero se publican a todo el mundo).
 *
 * Admite lo que usan los textos de `docs/legal/`: títulos `#` a `####`, párrafos, listas con y sin número (anidadas con dos espacios), tablas, citas `>`,
 * rayas `---`, **negrita**, *cursiva*, `código` y [enlaces](destino). Lo demás se queda como texto.
 */

export type LegalInline =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: LegalInline[] }
  | { type: 'em'; children: LegalInline[] }
  | { type: 'code'; value: string }
  | { type: 'link'; href: string; children: LegalInline[] };

export interface LegalListItem {
  inline: LegalInline[];
  children: LegalBlock[];
}

export type LegalBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; id: string; inline: LegalInline[] }
  | { type: 'paragraph'; inline: LegalInline[] }
  | { type: 'list'; ordered: boolean; start: number; items: LegalListItem[] }
  | { type: 'table'; header: LegalInline[][]; rows: LegalInline[][][] }
  | { type: 'quote'; blocks: LegalBlock[] }
  | { type: 'rule' };

const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const RULE = /^\s*(?:-{3,}|\*{3,})\s*$/;
const LIST_ITEM = /^(\s*)([-*]|\d{1,3}\.)\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Ancla de un título: minúsculas, sin acentos ni signos (`## 4.1 Cómo avisarnos` → `41-como-avisarnos`). */
export function headingAnchor(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

/** Texto plano de una línea con formato (para las anclas y los títulos de la pestaña). */
export function plainText(inline: readonly LegalInline[]): string {
  return inline.map((node) => (node.type === 'text' || node.type === 'code' ? node.value : plainText(node.children))).join('');
}

/** Para cada posición, dónde está el siguiente `char` (o -1): se calcula una sola vez por línea, así buscar un cierre no vuelve a recorrer la línea. */
function nextPositions(source: string, char: string): Int32Array {
  const next = new Int32Array(source.length + 1).fill(-1);
  for (let index = source.length - 1; index >= 0; index -= 1) next[index] = source[index] === char ? index : next[index + 1]!;
  return next;
}

/**
 * Formato de una línea, en tiempo lineal (auditoría de seguridad del 5.10a: con expresiones regulares sobre el resto de la línea, un texto con muchos `**` o `[` sin
 * cerrar tardaba segundos en cada visita). Cada apertura busca su cierre con las tablas de `nextPositions`; si no lo tiene, se queda como texto.
 */
export function parseInline(source: string): LegalInline[] {
  const nodes: LegalInline[] = [];
  let text = '';
  const flush = () => {
    if (text !== '') nodes.push({ type: 'text', value: text });
    text = '';
  };
  const nextTick = nextPositions(source, '`');
  const nextStar = nextPositions(source, '*');
  const nextClose = nextPositions(source, ']');
  const nextOpen = nextPositions(source, '[');
  const nextParen = nextPositions(source, ')');
  const at = (table: Int32Array, from: number) => (from < source.length ? table[from]! : -1);
  const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char);
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '`') {
      const close = at(nextTick, index + 1);
      if (close > index + 1) {
        flush();
        nodes.push({ type: 'code', value: source.slice(index + 1, close) });
        index = close + 1;
        continue;
      }
    } else if (char === '*' && source[index + 1] === '*') {
      // Negrita: el primer «**» siguiente, con texto que no empieza ni acaba en blanco.
      let close = at(nextStar, index + 2);
      while (close !== -1 && source[close + 1] !== '*') close = at(nextStar, close + 1);
      const inner = close === -1 ? '' : source.slice(index + 2, close);
      if (inner !== '' && !isSpace(inner[0]) && !isSpace(inner.at(-1))) {
        flush();
        nodes.push({ type: 'strong', children: parseInline(inner) });
        index = close + 2;
        continue;
      }
    } else if (char === '*' && !isSpace(source[index + 1])) {
      // Cursiva: hasta el siguiente «*», que tiene que ir suelto (una cursiva no lleva negrita dentro: así cada apertura mira solo hasta el «*» siguiente).
      const close = at(nextStar, index + 1);
      const inner = close === -1 || source[close + 1] === '*' ? '' : source.slice(index + 1, close);
      if (inner !== '' && !isSpace(inner.at(-1))) {
        flush();
        nodes.push({ type: 'em', children: parseInline(inner) });
        index = close + 1;
        continue;
      }
    } else if (char === '[') {
      // Enlace: «[texto](destino)», sin corchetes dentro del texto ni espacios en el destino.
      const close = at(nextClose, index + 1);
      const reopen = at(nextOpen, index + 1);
      if (close > index + 1 && (reopen === -1 || reopen > close) && source[close + 1] === '(') {
        const end = at(nextParen, close + 2);
        const href = end === -1 ? '' : source.slice(close + 2, end);
        if (href !== '' && !/[\s(]/.test(href)) {
          flush();
          nodes.push({ type: 'link', href, children: parseInline(source.slice(index + 1, close)) });
          index = end + 1;
          continue;
        }
      }
    }
    text += char;
    index += 1;
  }
  flush();
  return nodes;
}

const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

const indentOf = (line: string): number => (/^\s*/.exec(line)?.[0].replace(/\t/g, '  ').length ?? 0);

/** Una lista que empieza en `lines[0]`: sus elementos tienen la sangría del primero; lo que va más adentro es de cada elemento (otra lista o su continuación). */
function parseList(lines: readonly string[], depth: number): LegalBlock {
  const first = LIST_ITEM.exec(lines[0]!)!;
  const base = first[1]!.length;
  const ordered = first[2] !== '-' && first[2] !== '*';
  const items: LegalListItem[] = [];
  let current: { text: string; inner: string[] } | null = null;
  const close = () => {
    if (current) items.push({ inline: parseInline(current.text), children: current.inner.length > 0 ? parseBlocks(current.inner, depth + 1) : [] });
  };
  for (const line of lines) {
    const item = LIST_ITEM.exec(line);
    if (item && item[1]!.length === base) {
      close();
      current = { text: item[3]!, inner: [] };
    } else if (current && current.inner.length === 0 && !item && indentOf(line) > base) {
      current.text += ` ${line.trim()}`;
    } else if (current) {
      current.inner.push(line.slice(Math.min(indentOf(line), base + 2)));
    }
  }
  close();
  return { type: 'list', ordered, start: ordered ? Number.parseInt(first[2]!, 10) : 1, items };
}

/**
 * Profundidad máxima de citas y listas anidadas (auditoría de seguridad del 5.10a): más adentro, las líneas se leen como texto. Un texto con miles de «>»
 * seguidos agotaría la pila y dejaría su página sin poder pintarse, y el archivo no se puede corregir.
 */
export const MAX_NESTING = 8;

export function parseBlocks(lines: readonly string[], depth = 0): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === '') {
      flush();
      index += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const inline = parseInline(heading[2]!);
      blocks.push({ type: 'heading', level: heading[1]!.length as 1 | 2 | 3 | 4, id: headingAnchor(plainText(inline)), inline });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }
    if (depth < MAX_NESTING && /^\s*>/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index]!)) quoted.push(lines[index++]!.replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', blocks: parseBlocks(quoted, depth + 1) });
      continue;
    }
    if (/^\s*\|/.test(line) && TABLE_SEPARATOR.test(lines[index + 1] ?? '')) {
      flush();
      const header = cellsOf(line).map(parseInline);
      index += 2;
      const rows: LegalInline[][][] = [];
      while (index < lines.length && /^\s*\|/.test(lines[index]!)) rows.push(cellsOf(lines[index++]!).map(parseInline));
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    if (depth < MAX_NESTING && LIST_ITEM.test(line) && paragraph.length === 0) {
      const base = indentOf(line);
      const region: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index]!;
        if (candidate.trim() === '' || (indentOf(candidate) <= base && !LIST_ITEM.test(candidate))) break;
        region.push(candidate);
        index += 1;
      }
      blocks.push(parseList(region, depth));
      continue;
    }
    paragraph.push(line.trim());
    index += 1;
  }
  flush();
  return blocks;
}

export function parseLegalMarkdown(markdown: string): LegalBlock[] {
  return parseBlocks(markdown.replace(/\r\n/g, '\n').split('\n'));
}

/** Los textos archivados no cambian: su lectura se guarda por huella (las últimas 64), así una página no se vuelve a leer en cada visita. */
const CACHE_SIZE = 64;
const cache = new Map<string, LegalBlock[]>();
export function parseLegalMarkdownCached(contentSha256: string, markdown: string): LegalBlock[] {
  const hit = cache.get(contentSha256);
  if (hit) return hit;
  const blocks = parseLegalMarkdown(markdown);
  cache.set(contentSha256, blocks);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return blocks;
}
