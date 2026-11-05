import { z } from 'zod';

/**
 * Forma del contenido de una página pilar en `messages/{es,ca,en}.json` (`marketing.pages.<clave>`). Se valida al leerlo: un catálogo mal
 * formado falla en la compilación y en las pruebas, no con un hueco en pantalla. Todas las páginas pilar comparten esta estructura para que
 * una única plantilla las dibuje y los metadatos y el JSON-LD salgan del mismo texto que ve la persona.
 */
const sectionSchema = z.object({
  title: z.string().min(1),
  paragraphs: z.array(z.string().min(1)).optional(),
  bullets: z.array(z.string().min(1)).optional(),
  steps: z.array(z.object({ title: z.string().min(1), text: z.string().min(1) })).optional(),
  faq: z.array(z.object({ q: z.string().min(1), a: z.string().min(1) })).optional()
});

export const pillarContentSchema = z.object({
  /** Título de la pestaña y de los resultados de búsqueda, sin ` · KORUM` (lo añade la plantilla). */
  title: z.string().min(1),
  description: z.string().min(1),
  h1: z.string().min(1),
  /** Primer párrafo: responde a la pregunta principal de la página en una o dos frases citables. */
  answer: z.string().min(1),
  sections: z.array(sectionSchema).min(1),
  ctaTitle: z.string().min(1),
  ctaText: z.string().min(1)
});

export type PillarSection = z.infer<typeof sectionSchema>;
export type PillarContent = z.infer<typeof pillarContentSchema>;

export function parsePillarContent(raw: unknown): PillarContent {
  return pillarContentSchema.parse(raw);
}

/** Todas las preguntas con respuesta de una página, para el JSON-LD `FAQPage`. */
export function collectFaq(content: PillarContent): Array<{ q: string; a: string }> {
  return content.sections.flatMap((section) => section.faq ?? []);
}
