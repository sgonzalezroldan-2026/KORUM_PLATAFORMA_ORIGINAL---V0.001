import { z } from 'zod';
import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeSuperadmin, authorizeTenant, recordAudit, ResourceNotFoundError, type SessionActor } from './tenant-guard';

/** Entidades (tenants). Cada función autoriza primero y solo después consulta. Los campos se eligen uno a uno (`select`). */

/** Personas con gestión de la entidad: quien dirige y quien cofirma. */
const STAFF = ['DIRECTOR', 'COSIGNER'] as const;

const ORGANIZATION_VIEW = {
  id: true,
  slug: true,
  name: true,
  legalName: true,
  legalForm: true,
  centerOwnership: true,
  vertical: true,
  province: true,
  provinceCode: true,
  contactEmail: true,
  contactPhone: true,
  cif: true,
  iban: true,
  kybStatus: true,
  health: true,
  medalRank: true,
  ley49: true,
  ley49VerifiedAt: true,
  exemptLimitCents: true,
  exemptRemainingCents: true,
  medalGrantAvailableCents: true,
  maintActive: true,
  maintPaidCents: true,
  maintAnnualCapCents: true,
  brandPrimary: true,
  brandSecondary: true,
  contentLocale: true,
  publicIndexing: true,
  quotaPeriod: true,
  archivedAt: true
} as const;

/** Resuelve el identificador de una entidad a partir del `orgSlug` de la URL (dato público; no concede acceso por sí solo). */
export async function findOrganizationIdBySlug(db: KorumPrismaClient, slug: string): Promise<string | null> {
  const organization = await db.organization.findFirst({ where: { slug, archivedAt: null }, select: { id: true } });
  return organization?.id ?? null;
}

/** Ficha completa de la entidad para quien la gestiona (incluye CIF e IBAN: nunca se exponen en público). */
export async function getOrganization(db: KorumPrismaClient, actor: SessionActor, organizationId: string) {
  await authorizeTenant(db, actor, organizationId, { roles: STAFF, action: 'organization.get', targetType: 'Organization' });
  const organization = await db.organization.findUnique({ where: { id: organizationId }, select: ORGANIZATION_VIEW });
  if (!organization) throw new ResourceNotFoundError('Entidad');
  return organization;
}

/** Listado transversal de entidades: solo el Super-Admin (queda registrado en `AuditLog`). */
export async function listOrganizations(db: KorumPrismaClient, actor: SessionActor) {
  await authorizeSuperadmin(db, actor, 'organization.list', 'Organization');
  return db.organization.findMany({ select: ORGANIZATION_VIEW, orderBy: { name: 'asc' } });
}

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color no válido: usa el formato #RRGGBB');
export const brandingSchema = z.object({ brandPrimary: hexColor, brandSecondary: hexColor }).strict();
export type BrandingInput = z.infer<typeof brandingSchema>;

/**
 * Cambia los colores de la entidad. Solo quien dirige la entidad (o el Super-Admin); valida la entrada con Zod, escribe
 * solo esos dos campos sobre la entidad ya autorizada y deja constancia del antes y el después en `AuditLog`.
 */
export async function updateOrganizationBranding(db: KorumPrismaClient, actor: SessionActor, organizationId: string, input: unknown): Promise<BrandingInput> {
  await authorizeTenant(db, actor, organizationId, { roles: ['DIRECTOR'], action: 'organization.branding.update', targetType: 'Organization' });
  const branding = brandingSchema.parse(input);
  const before = await db.organization.findUnique({ where: { id: organizationId }, select: { brandPrimary: true, brandSecondary: true } });
  if (!before) throw new ResourceNotFoundError('Entidad');
  // El cambio y su rastro se escriben juntos: si no se puede auditar, no se cambia.
  await db.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: organizationId }, data: branding });
    await recordAudit(tx, actor, { action: 'organization.branding.updated', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { before, after: branding } }, { required: true });
  });
  return branding;
}
