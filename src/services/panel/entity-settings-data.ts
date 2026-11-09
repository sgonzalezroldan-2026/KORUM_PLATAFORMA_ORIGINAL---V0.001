import { kybReadiness, requiredKybKinds, settingsFromColumns, type EntitySettingsInput, type KybDocumentKind, type KybReadiness, type KybStatus } from '@/core/panel/entity-settings-rules';
import { accentByHex, type EntityAccentId } from '@/core/brand/entity-palette';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { publicFileId } from '@/repositories/public.repository';
import { participationGroupsView, type ParticipationGroupsData } from './participation-groups.service';
import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeTenant, ResourceNotFoundError, type SessionActor } from '@/repositories/tenant-guard';

/**
 * Lo que enseña la página de ajustes de la entidad (Sprint 4.2c). Solo las personas firmantes de la entidad o el Super-Admin (con registro, en solo
 * lectura). Campos uno a uno: del titular, su razón social, CIF y régimen; de cada documento, su tipo, fecha y formato, nunca la ruta del fichero
 * en el almacén ni quién lo subió.
 */

export interface KybDocumentView {
  id: number;
  kind: KybDocumentKind;
  uploadedAt: string;
  mimeType: string;
  sizeBytes: number;
}

export interface EntitySettingsData {
  kyb: {
    status: KybStatus;
    legalName: string;
    legalForm: string;
    cif: string | null;
    ley49: boolean;
    ley49Verified: boolean;
    submittedAt: string | null;
    reviewNote: string | null;
    required: KybDocumentKind[];
    documents: KybDocumentView[];
    /** Documentos que se sustituyeron y se conservan por ley (no se enseñan, solo cuántos). */
    replacedCount: number;
    readiness: KybReadiness;
  };
  settings: EntitySettingsInput;
  /** Grupos de participación e identidad visual (Sprint 4.2e). */
  groups: ParticipationGroupsData;
  brand: { name: string; accentHex: string; accent: EntityAccentId | null; logoFileId: string | null; bannerFileId: string | null };
}

const asStatus = (value: string): KybStatus => (value === 'SUBMITTED' || value === 'VERIFIED' || value === 'REJECTED' ? value : 'PENDING');

export async function loadEntitySettings(db: KorumPrismaClient, actor: SessionActor, organizationId: string): Promise<EntitySettingsData> {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'organization.settings_view', targetType: 'Organization', targetId: organizationId });
  const [organization, documents, replacedCount] = await Promise.all([
    db.organization.findUnique({
      where: { id: organizationId },
      select: {
        kybStatus: true,
        legalName: true,
        legalForm: true,
        cif: true,
        ley49: true,
        ley49VerifiedAt: true,
        kybSubmittedAt: true,
        kybReviewNote: true,
        donationPresetsCents: true,
        defaultDonationIdx: true,
        minVotes: true,
        maxIdeaDays: true,
        sponsorTiersCents: true,
        phone: true,
        contentLocale: true,
        publicIndexing: true,
        name: true,
        vertical: true,
        participationGroupsJson: true,
        brandPrimary: true,
        logoFile: { select: { id: true, visibility: true, deletedAt: true } },
        bannerFile: { select: { id: true, visibility: true, deletedAt: true } }
      }
    }),
    db.kybDocument.findMany({
      where: { organizationId, replacedAt: null },
      orderBy: { id: 'asc' },
      select: { id: true, kind: true, createdAt: true, file: { select: { mimeType: true, sizeBytes: true } } }
    }),
    db.kybDocument.count({ where: { organizationId, replacedAt: { not: null } } })
  ]);
  if (!organization) throw new ResourceNotFoundError('Entidad');
  const status = asStatus(organization.kybStatus);

  return {
    kyb: {
      status,
      legalName: organization.legalName,
      legalForm: organization.legalForm,
      cif: organization.cif,
      ley49: organization.ley49,
      ley49Verified: organization.ley49 && organization.ley49VerifiedAt !== null,
      submittedAt: organization.kybSubmittedAt?.toISOString() ?? null,
      // La nota de una devolución solo tiene sentido mientras está devuelta.
      reviewNote: status === 'REJECTED' ? organization.kybReviewNote : null,
      required: requiredKybKinds(organization.ley49),
      documents: documents.map((document) => ({ id: document.id, kind: document.kind, uploadedAt: document.createdAt.toISOString(), mimeType: document.file.mimeType, sizeBytes: document.file.sizeBytes })),
      replacedCount,
      readiness: kybReadiness({ ley49: organization.ley49, cif: organization.cif, currentKinds: documents.map((document) => document.kind) })
    },
    settings: settingsFromColumns(organization),
    groups: participationGroupsView(organization.vertical, organization.participationGroupsJson),
    brand: {
      name: organization.name,
      accentHex: organization.brandPrimary,
      accent: accentByHex(organization.brandPrimary)?.id ?? null,
      logoFileId: publicFileId(organization.logoFile),
      bannerFileId: publicFileId(organization.bannerFile)
    }
  };
}
