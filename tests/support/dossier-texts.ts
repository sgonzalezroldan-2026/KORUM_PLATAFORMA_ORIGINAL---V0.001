import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createTranslator } from 'next-intl';
import type { DossierTexts } from '@/core/dossier/dossier-pdf';
import { dossierTextsFrom } from '@/core/dossier/dossier-texts';

/**
 * Textos del expediente exportable leídos del catálogo real de un idioma (`messages/{idioma}.json`), como los compone la descarga. Una clave que no exista
 * rompe la prueba: no hay textos de reserva.
 */

type Lang = 'es' | 'ca' | 'en';
type Translate = (key: string, values?: Record<string, string | number>) => string;

export function catalogDossierTexts(locale: Lang): DossierTexts {
  const messages = JSON.parse(readFileSync(path.join(process.cwd(), 'messages', `${locale}.json`), 'utf8')) as Record<string, unknown>;
  const translate = createTranslator({
    locale,
    messages,
    onError: (error) => {
      throw error;
    }
  }) as unknown as Translate;
  const under =
    (namespace: string): Translate =>
    (key, values) =>
      translate(`${namespace}.${key}`, values);
  return dossierTextsFrom({ dossier: under('audit.dossier'), audit: under('audit'), actions: under('audit.actions'), statuses: under('status.initiative'), roles: under('panel.approvals.doubleCheck.roles') });
}
