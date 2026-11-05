import type { Locale } from '@/i18n/routing';

/**
 * Contenido de `/llms.txt` (skill korum-seo-discoverability §5): un resumen en Markdown para asistentes de IA con qué es KORUM, para quién
 * es, cómo funciona el dinero y las páginas pilar de cada idioma. Función pura: la ruta le pasa los textos ya traducidos y con las tarifas
 * vigentes, para que lo que cita un asistente coincida con lo que ve una persona en la web.
 */
export interface LlmsSection {
  locale: Locale;
  /** Nombre del idioma en ese idioma («Castellano», «Català», «English»). */
  languageName: string;
  summary: string;
  money: string;
  figuresTitle: string;
  figures: string[];
  pagesTitle: string;
  pages: Array<{ title: string; description: string; url: string }>;
}

export function buildLlmsTxt(sections: readonly LlmsSection[]): string {
  const [first] = sections;
  if (!first) throw new RangeError('llms.txt necesita al menos un idioma');

  const lines: string[] = ['# KORUM', '', `> ${first.summary}`, ''];
  for (const section of sections) {
    lines.push(`## ${section.languageName}`, '', section.summary, '', section.money, '', `### ${section.figuresTitle}`, '');
    lines.push(...section.figures.map((figure) => `- ${figure}`), '', `### ${section.pagesTitle}`, '');
    lines.push(...section.pages.map((page) => `- [${page.title}](${page.url}): ${page.description}`), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
