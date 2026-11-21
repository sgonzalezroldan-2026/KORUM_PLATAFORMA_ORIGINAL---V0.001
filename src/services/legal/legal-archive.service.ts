import { createHash } from 'node:crypto';
import { compareLegalVersions } from '@/core/admin/settings-model';
import { effectiveDateFor, ENTITY_NOTICE_DOCUMENTS, LEGAL_BASE_LOCALE, type LegalDocument, type LegalLocale } from '@/core/legal/legal-catalog';
import type { Db } from '@/lib/db';
import { queueEntityNotices } from './legal-notices';

/**
 * Archivo de los textos legales (Sprint 5.10a, `L-057`, `QA-LEG01`). Cada versión publicada desde la consola se guarda aquí, tal como se publicó (con los datos
 * de la empresa ya puestos), con su huella SHA-256 y sus fechas; la base impide reescribirla o borrarla. Las páginas públicas enseñan la última versión de cada
 * idioma o la del castellano, con un aviso, si ese idioma no tiene traducción o su traducción es anterior a la última versión en castellano (decisión 85,
 * ampliada por el promotor el 2026-11-21), y cada aceptación apunta a una versión de este archivo.
 */

export class LegalVersionConflictError extends Error {
  constructor(readonly reason: 'VERSION_IN_USE' | 'VERSION_OLDER' | 'URGENT_NOT_ONLY_PROVIDERS' | 'SUMMARY_REQUIRED') {
    super(`No se puede archivar esa versión del texto legal: ${reason}`);
    this.name = 'LegalVersionConflictError';
  }
}

export const legalContentHash = (markdown: string): string => createHash('sha256').update(markdown, 'utf8').digest('hex');

/**
 * Ordena la publicación de los textos de las entidades con las altas (auditoría de seguridad del 5.10a): quien publica toma el bloqueo exclusivo y cada alta el
 * compartido. Así un alta nunca acepta una versión que se está sustituyendo, y la entidad que acaba de darse de alta recibe el aviso de la versión nueva.
 */
const ENTITY_TEXTS_LOCK = 'korum:legal:entity-texts';
export async function lockEntityLegalTexts(tx: Db, mode: 'shared' | 'exclusive'): Promise<void> {
  if (mode === 'shared') await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${ENTITY_TEXTS_LOCK}))::text`;
  else await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${ENTITY_TEXTS_LOCK}))::text`;
}

export interface ArchivedLegalVersion {
  document: LegalDocument;
  /** Idioma del texto archivado (puede ser el castellano aunque la persona lea en otro idioma). */
  locale: LegalLocale;
  version: string;
  markdown: string;
  contentSha256: string;
  publishedAt: Date;
  effectiveAt: Date;
  changeSummary: string | null;
}

export interface ResolvedLegalVersion extends ArchivedLegalVersion {
  /** Se enseña la del castellano porque el idioma pedido no tiene traducción (`MISSING`) o la suya es anterior a la última en castellano (`STALE`). */
  fallback: false | 'MISSING' | 'STALE';
}

const SELECT = { document: true, locale: true, version: true, markdown: true, contentSha256: true, publishedAt: true, effectiveAt: true, changeSummary: true } as const;
const NEWEST_FIRST = [{ publishedAt: 'desc' as const }, { id: 'desc' as const }];

type Row = { document: string; locale: string; version: string; markdown: string; contentSha256: string; publishedAt: Date; effectiveAt: Date; changeSummary: string | null };
const asArchived = (row: Row): ArchivedLegalVersion => ({ ...row, document: row.document as LegalDocument, locale: row.locale as LegalLocale });

async function latestOf(db: Db, document: LegalDocument, locale: LegalLocale): Promise<ArchivedLegalVersion | null> {
  const row = await db.legalDocumentVersion.findFirst({ where: { document, locale }, orderBy: NEWEST_FIRST, select: SELECT });
  return row ? asArchived(row) : null;
}

/** La versión vigente de un texto en un idioma: la suya si existe y no es anterior a la última en castellano; si no, la del castellano. `null` si no hay ninguna. */
export async function resolveLegalVersion(db: Db, document: LegalDocument, locale: LegalLocale): Promise<ResolvedLegalVersion | null> {
  const base = await latestOf(db, document, LEGAL_BASE_LOCALE);
  if (locale === LEGAL_BASE_LOCALE) return base ? { ...base, fallback: false } : null;
  const own = await latestOf(db, document, locale);
  if (own && (!base || own.publishedAt >= base.publishedAt)) return { ...own, fallback: false };
  return base ? { ...base, fallback: own ? 'STALE' : 'MISSING' } : null;
}

/** Todas las versiones archivadas de un texto en un idioma, de la más reciente a la más antigua (el archivo de versiones de cada página). */
export async function listLegalVersions(db: Db, document: LegalDocument, locale: LegalLocale): Promise<Array<Omit<ArchivedLegalVersion, 'markdown'>>> {
  const rows = await db.legalDocumentVersion.findMany({ where: { document, locale }, orderBy: NEWEST_FIRST, select: { ...SELECT, markdown: false } });
  return rows.map((row) => ({ ...row, document: row.document as LegalDocument, locale: row.locale as LegalLocale }));
}

export async function findLegalVersion(db: Db, document: LegalDocument, locale: LegalLocale, version: string): Promise<ArchivedLegalVersion | null> {
  const row = await db.legalDocumentVersion.findUnique({ where: { document_locale_version: { document, locale, version } }, select: SELECT });
  return row ? asArchived(row) : null;
}

/** La versión de la política de privacidad que tiene delante una persona: la vigente en el idioma de su cuenta. `null` si no hay ninguna publicada. */
export async function policyForUser(db: Db, userId: string): Promise<{ version: string; locale: LegalLocale } | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { locale: true } });
  const policy = await resolveLegalVersion(db, 'privacidad', user?.locale ?? LEGAL_BASE_LOCALE);
  return policy ? { version: policy.version, locale: policy.locale } : null;
}

/** Lo que va antes del Anexo III del contrato de encargo: en un cambio urgente no puede cambiar nada de esto (cláusula 10; decisión 58). */
const PROVIDERS_ANNEX = /^## Anexo III\b/m;
/** Lo que va antes de la primera aparición del Anexo III (todo el texto, si no lo tiene). */
const beforeProviders = (markdown: string) => {
  const at = markdown.search(PROVIDERS_ANNEX);
  return at < 0 ? markdown : markdown.slice(0, at);
};

/**
 * Un cambio urgente solo toca la lista de proveedores (auditoría de seguridad del 5.10a): lo anterior al Anexo III no cambia y, desde su título, no aparece ningún
 * otro título de nivel 1 o 2 (ni un apartado nuevo ni un segundo «Anexo III» con algo detrás).
 */
function onlyProvidersChange(before: string, after: string): boolean {
  const at = after.search(PROVIDERS_ANNEX);
  if (at < 0 || beforeProviders(before) !== after.slice(0, at)) return false;
  const providers = after.slice(at);
  const firstBreak = providers.indexOf('\n');
  return firstBreak < 0 || !/^#{1,2}\s/m.test(providers.slice(firstBreak + 1));
}

export interface ArchiveInput {
  document: LegalDocument;
  locale: LegalLocale;
  version: string;
  /** El texto final, con los datos de la empresa ya puestos: es lo que se enseña y lo que se acepta. */
  markdown: string;
  now: Date;
  /** Qué cambia respecto a la versión anterior (obligatorio en una versión nueva de los textos de las entidades). */
  changeSummary?: string | null;
  /** Cambio urgente del contrato de encargo (decisión 58): solo la lista de proveedores; se aplica al momento y el aviso lo dice. */
  urgent?: boolean;
}

/**
 * Archiva una versión publicada. Se llama dentro de la transacción de la publicación. Si esa misma versión ya está archivada con el mismo texto, no hace nada
 * (volver a guardar lo mismo); con otro texto, o si es anterior a la última archivada en su idioma, se rechaza: una versión publicada no se reescribe.
 * Una versión de las condiciones para entidades o del contrato de encargo que sustituye a la que leían sus firmantes (en su idioma o, en otro idioma, la del
 * castellano) se les aplica a los 30 días y les deja el aviso en la bandeja.
 */
export async function archiveLegalVersion(tx: Db, input: ArchiveInput): Promise<{ created: boolean; effectiveAt: Date; notices: number }> {
  const entityText = ENTITY_NOTICE_DOCUMENTS.includes(input.document);
  if (entityText) await lockEntityLegalTexts(tx, 'exclusive');
  const contentSha256 = legalContentHash(input.markdown);
  const existing = await tx.legalDocumentVersion.findUnique({ where: { document_locale_version: { document: input.document, locale: input.locale, version: input.version } }, select: { contentSha256: true, effectiveAt: true } });
  if (existing) {
    if (existing.contentSha256 !== contentSha256) throw new LegalVersionConflictError('VERSION_IN_USE');
    return { created: false, effectiveAt: existing.effectiveAt, notices: 0 };
  }
  const previous = await latestOf(tx, input.document, input.locale);
  if (previous && compareLegalVersions(input.version, previous.version) <= 0) throw new LegalVersionConflictError('VERSION_OLDER');
  // Lo que leían hasta ahora quienes leen este idioma: su versión anterior o, sin ella, la del castellano.
  const replaced = previous ?? (input.locale === LEGAL_BASE_LOCALE ? null : await latestOf(tx, input.document, LEGAL_BASE_LOCALE));
  const summary = input.changeSummary?.trim() || null;
  if (entityText && replaced && !summary) throw new LegalVersionConflictError('SUMMARY_REQUIRED');
  if (input.urgent && replaced && !onlyProvidersChange(replaced.markdown, input.markdown)) throw new LegalVersionConflictError('URGENT_NOT_ONLY_PROVIDERS');
  const effectiveAt = effectiveDateFor(input.document, input.now, replaced !== null, input.urgent === true);
  await tx.legalDocumentVersion.create({
    data: { document: input.document, locale: input.locale, version: input.version, markdown: input.markdown, contentSha256, publishedAt: input.now, effectiveAt, changeSummary: summary }
  });
  const notices = entityText && replaced ? await queueEntityNotices(tx, { document: input.document, locale: input.locale, version: input.version, effectiveAt, changeSummary: summary, urgent: input.urgent === true }) : 0;
  return { created: true, effectiveAt, notices };
}

export type LegalAcceptanceSource = 'alta' | 'cuenta' | 'hucha';

export interface AcceptanceInput {
  userId: string | null;
  organizationId: string | null;
  source: LegalAcceptanceSource;
  items: ReadonlyArray<{ document: LegalDocument; locale: LegalLocale; version: string }>;
  now: Date;
}

/** Registra lo que se aceptó. La clave foránea impide aceptar una versión que no esté archivada (publicada). */
export async function recordLegalAcceptances(tx: Db, input: AcceptanceInput): Promise<void> {
  if (input.items.length === 0) return;
  await tx.legalAcceptance.createMany({
    data: input.items.map((item) => ({ userId: input.userId, organizationId: input.organizationId, document: item.document, locale: item.locale, version: item.version, source: input.source, acceptedAt: input.now }))
  });
}

/**
 * Cuenta nueva (primeras capas §11): al entrar por primera vez o al aceptar una invitación, la persona acepta las condiciones de uso vigentes en su idioma. Sin
 * condiciones publicadas no se registra nada, y una cuenta que ya las aceptó no las vuelve a registrar.
 */
export async function recordAccountTermsAcceptance(db: Db, userId: string, now: Date): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { locale: true } });
  if (!user) return false;
  if (await db.legalAcceptance.findFirst({ where: { userId, source: 'cuenta' }, select: { id: true } })) return false;
  const terms = await resolveLegalVersion(db, 'terminos', user.locale);
  if (!terms) return false;
  await recordLegalAcceptances(db, { userId, organizationId: null, source: 'cuenta', items: [{ document: 'terminos', locale: terms.locale, version: terms.version }], now });
  return true;
}
