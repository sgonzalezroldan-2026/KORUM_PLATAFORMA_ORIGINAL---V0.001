import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { declaredVersion, fillMarkers, LEGAL_DOCUMENT_INFO, LEGAL_DOCUMENTS, publishableMarkdown, type LegalDocument, type LegalMarkerValues } from '../core/legal/legal-catalog';
import type { KorumPrismaClient } from '../lib/prisma';

/**
 * Los nueve textos legales de `docs/legal/` (SESIÓN T1, validados por el promotor) tal como se publican: sin las notas internas, con la versión que declara cada
 * archivo y con los datos de la empresa puestos, como hace la consola al publicar. Los usan la semilla de demostración y la base de las pruebas de integración
 * (Sprint 5.10a). En producción no se cargan solos: los publica el Super-Admin desde la consola, con los datos reales y su auditoría. Solo importaciones
 * relativas: lo carga también la preparación de las pruebas.
 */

/** Datos de empresa de demostración, a la vista como ficticios. Nunca llegan a producción (la semilla no se ejecuta allí, `seed-guard`). */
export const DEMO_COMPANY = {
  legalName: 'KORUM Plataforma (empresa de demostración)',
  taxId: 'A58818501',
  address: 'Calle de la Demostración 1, 08001 Barcelona',
  supportEmail: 'soporte@korum.example',
  privacyEmail: 'privacidad@korum.example',
  registryData: 'Datos registrales de demostración (sociedad ficticia)'
} as const;

export interface LegalSeedText {
  document: LegalDocument;
  locale: 'es';
  version: string;
  /** El texto final, con los datos de la empresa: el que se archiva. */
  markdown: string;
  contentSha256: string;
  /** El texto con sus marcas `[[…]]`, como lo guarda la consola para editarlo. */
  template: string;
}

const demoMarkers = (): LegalMarkerValues => ({ ...DEMO_COMPANY, domain: new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').host });

export function loadLegalSeedTexts(rootDir: string = process.cwd()): LegalSeedText[] {
  const markers = demoMarkers();
  return LEGAL_DOCUMENTS.map((document) => {
    const file = path.join(rootDir, 'docs', 'legal', LEGAL_DOCUMENT_INFO[document].sourceFile);
    const text = fs.readFileSync(file, 'utf8');
    const version = declaredVersion(text);
    if (!version) throw new Error(`${LEGAL_DOCUMENT_INFO[document].sourceFile} no declara su versión («**Versión:** AAAA-MM-DD»)`);
    const template = publishableMarkdown(text);
    const markdown = fillMarkers(template, markers, '');
    return { document, locale: 'es' as const, version, markdown, template, contentSha256: createHash('sha256').update(markdown, 'utf8').digest('hex') };
  });
}

/**
 * Semilla de demostración: los datos de empresa de demostración (si la consola aún no tiene otros) y, en castellano, los textos que aún no tengan ninguna versión,
 * en el archivo y en la consola (`legal.{documento}.es`). No toca lo que ya está publicado: volver a sembrar conserva las versiones y sus fechas.
 */
export async function seedLegalTexts(db: Pick<KorumPrismaClient, 'legalDocumentVersion' | 'platformSetting'>, now: Date): Promise<number> {
  await db.platformSetting.upsert({ where: { key: 'platform.company' }, create: { key: 'platform.company', valueJson: DEMO_COMPANY }, update: {} });
  let created = 0;
  for (const text of loadLegalSeedTexts()) {
    if (await db.legalDocumentVersion.findFirst({ where: { document: text.document, locale: text.locale }, select: { id: true } })) continue;
    await db.legalDocumentVersion.create({ data: { document: text.document, locale: text.locale, version: text.version, markdown: text.markdown, contentSha256: text.contentSha256, publishedAt: now, effectiveAt: now } });
    const key = `legal.${text.document}.${text.locale}`;
    await db.platformSetting.upsert({ where: { key }, create: { key, valueJson: { version: text.version, status: 'PUBLICADO', markdown: text.template } }, update: {} });
    created += 1;
  }
  return created;
}
