import { buildMedalSealSvg, medalLevels, isKitAvailable } from '@/core/medals/medal-kit';
import { renderMedalReportPdf, type MedalReportTranslator } from '@/core/medals/medal-report';
import type { KorumPrismaClient } from '@/lib/prisma';
import { getMedalImpact } from '@/repositories/panel.repository';
import { recordAudit, type SessionActor } from '@/repositories/tenant-guard';

/**
 * Descarga del kit de una medalla (Sprint 4.1): el informe de impacto en PDF y el sello para la web en SVG. Solo del nivel que la entidad **ya
 * tiene**: presumir en público de un nivel por conseguir sería engañar a las familias. Cada descarga queda en `AuditLog` (sin datos personales).
 */

export type MedalKitKind = 'report' | 'seal';

export class MedalKitUnavailableError extends Error {
  constructor(readonly reason: 'UNKNOWN_LEVEL' | 'NOT_EARNED') {
    super(`Kit de medalla no disponible: ${reason}.`);
    this.name = 'MedalKitUnavailableError';
  }
}

export interface MedalKitFile {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
}

export interface MedalKitRequest {
  organizationId: string;
  levelKey: string;
  kind: MedalKitKind;
  locale: 'es' | 'ca' | 'en';
  /** Nombre del nivel en el idioma de la persona, por clave (`bronze`, `silver`, `gold`). Si falta, vale el de la consola. */
  tierNames?: Record<string, string>;
  /** Traductores de `panel.medals.report` y `panel.medals.seal`, ya enlazados al idioma. */
  translate: { report: MedalReportTranslator; seal: (key: string, values?: Record<string, string>) => string };
  now: Date;
}

const slugify = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'entidad';

export async function buildMedalKitFile(db: KorumPrismaClient, actor: SessionActor, request: MedalKitRequest): Promise<MedalKitFile> {
  const impact = await getMedalImpact(db, actor, request.organizationId, request.now);
  const levels = medalLevels(impact.tiers, impact.organization.medalRank, 0);
  const level = levels.find((candidate) => candidate.key === request.levelKey);
  if (!level) throw new MedalKitUnavailableError('UNKNOWN_LEVEL');
  if (!isKitAvailable(level)) {
    await recordAudit(db, actor, { action: 'panel.medal_kit_denied', organizationId: request.organizationId, targetType: 'MedalTier', targetId: level.key, metadata: { kind: request.kind } });
    throw new MedalKitUnavailableError('NOT_EARNED');
  }

  const period = impact.organization.quotaPeriod ?? '';
  const tierName = request.tierNames?.[level.key] ?? level.name;
  // La clave viene de la consola: en el nombre del fichero solo van letras, cifras y guiones.
  const base = `korum-medalla-${level.key.replace(/[^a-zA-Z0-9-]/g, '')}-${slugify(impact.organization.name)}`;
  await recordAudit(db, actor, { action: 'panel.medal_kit_downloaded', organizationId: request.organizationId, targetType: 'MedalTier', targetId: level.key, metadata: { kind: request.kind, period } });

  if (request.kind === 'seal') {
    const svg = buildMedalSealSvg({
      rank: level.rank,
      tierName,
      entityName: impact.organization.name,
      period,
      headline: request.translate.seal('headline'),
      accessibleName: request.translate.seal('accessibleName', { tier: tierName, entity: impact.organization.name, period })
    });
    return { bytes: new TextEncoder().encode(svg), contentType: 'image/svg+xml; charset=utf-8', fileName: `${base}.svg` };
  }

  const bytes = renderMedalReportPdf(
    {
      entityName: impact.organization.name,
      period,
      tierName,
      completedCampaigns: impact.achievements.length,
      totalRaisedCents: impact.achievements.reduce((sum, item) => sum + item.raisedCents, 0),
      activeSponsors: impact.activeSponsors,
      achievements: impact.achievements,
      generatedAt: request.now,
      locale: request.locale
    },
    request.translate.report
  );
  return { bytes, contentType: 'application/pdf', fileName: `${base}.pdf` };
}
