import { LEGAL_BASE_LOCALE, type LegalDocument, type LegalLocale, type LegalMarkerValues } from '@/core/legal/legal-catalog';
import { LEGAL_VERSION_PATTERN } from '@/core/admin/settings-model';
import type { Db } from '@/lib/db';
import { siteUrl } from '@/lib/seo/marketing-routes';
import { getSetting, InvalidSettingError } from '@/services/settings/settings.service';
import { findLegalVersion, listLegalVersions, resolveLegalVersion, type ArchivedLegalVersion, type ResolvedLegalVersion } from './legal-archive.service';

/**
 * Lo que necesita la página pública de un texto legal (Sprint 5.10a, `QA-LEG01`): la versión vigente en el idioma de la página (o la del castellano, si aún no
 * está traducida o su traducción es anterior), o una versión anterior del archivo si se pide con `?version=`; la lista de versiones; y, si la vigente aún no se
 * aplica a las entidades ya dadas de alta, la que se les sigue aplicando hasta entonces. El texto archivado ya lleva los datos de la empresa: se enseña tal cual.
 */

type VersionInfo = Pick<ArchivedLegalVersion, 'version' | 'locale' | 'publishedAt' | 'effectiveAt'>;

export interface LegalPageData {
  shown: ArchivedLegalVersion;
  fallback: ResolvedLegalVersion['fallback'];
  /** Se está viendo una versión que no es la vigente. */
  archived: boolean;
  current: VersionInfo;
  /** La versión que se sigue aplicando a quien ya había aceptado mientras la vigente no entra en vigor (30 días de las entidades). */
  stillApplying: VersionInfo | null;
  /** La versión que se ve es la que aún se aplica a las entidades ya dadas de alta (no una sustituida del todo). */
  shownStillApplies: boolean;
  versions: Array<Pick<ArchivedLegalVersion, 'version' | 'publishedAt' | 'effectiveAt' | 'contentSha256'>>;
}

/** Datos de la empresa para la primera capa del alta y del acceso. Si el ajuste guardado ya no es válido, se dicen sin ellos (la página no se cae). */
export async function legalMarkerValues(db: Db): Promise<LegalMarkerValues> {
  let company: Awaited<ReturnType<typeof getSetting<'platform.company'>>>;
  try {
    company = await getSetting(db, 'platform.company');
  } catch (error) {
    if (!(error instanceof InvalidSettingError)) throw error;
    company = undefined;
  }
  return { ...(company ?? {}), domain: new URL(siteUrl()).host };
}

/** La más reciente que ya se aplica (sin contar la vigente), entre las de este idioma y, si es otro idioma, las del castellano que se leían en su lugar. */
function stillApplyingOf(current: ResolvedLegalVersion, candidates: readonly VersionInfo[], now: Date): VersionInfo | null {
  if (current.effectiveAt <= now) return null;
  const applying = candidates.filter((item) => !(item.version === current.version && item.locale === current.locale) && item.effectiveAt <= now);
  applying.sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime() || b.publishedAt.getTime() - a.publishedAt.getTime());
  return applying[0] ?? null;
}

export async function loadLegalPage(db: Db, document: LegalDocument, locale: LegalLocale, requestedVersion: string | undefined, now: Date = new Date()): Promise<LegalPageData | null> {
  const current = await resolveLegalVersion(db, document, locale);
  if (!current) return null;
  let shown: ArchivedLegalVersion = current;
  if (requestedVersion !== undefined) {
    if (!LEGAL_VERSION_PATTERN.test(requestedVersion)) return null;
    const found = await findLegalVersion(db, document, current.locale, requestedVersion);
    if (!found) return null;
    shown = found;
  }
  const versions = await listLegalVersions(db, document, current.locale);
  const others = locale !== LEGAL_BASE_LOCALE ? await listLegalVersions(db, document, current.locale === locale ? LEGAL_BASE_LOCALE : locale) : [];
  const stillApplying = stillApplyingOf(current, [...versions, ...others], now);
  const archived = shown.version !== current.version;
  return {
    shown,
    fallback: current.fallback,
    archived,
    current: { version: current.version, locale: current.locale, publishedAt: current.publishedAt, effectiveAt: current.effectiveAt },
    stillApplying,
    shownStillApplies: archived && stillApplying !== null && stillApplying.version === shown.version && stillApplying.locale === shown.locale,
    versions: versions.map(({ version, publishedAt, effectiveAt, contentSha256 }) => ({ version, publishedAt, effectiveAt, contentSha256 }))
  };
}
