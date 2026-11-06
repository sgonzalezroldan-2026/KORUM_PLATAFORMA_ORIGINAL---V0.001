import { z } from 'zod';
import type { KorumPrismaClient } from '@/lib/prisma';
import { listPendingCosignerInvitations } from '@/core/onboarding/invitations';
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

export type SignerStatus = 'ACTIVE' | 'NEEDS_TWO_FACTOR' | 'INVITED';

/**
 * Personas firmantes de la entidad y en qué punto está cada una (Sprint 3.2): invitada (aún no ha aceptado), activa sin TOTP o lista para
 * firmar. Solo nombre, cargo y estado: ni el email ni el teléfono de la otra persona.
 */
export async function listSigners(db: KorumPrismaClient, actor: SessionActor, organizationId: string) {
  await authorizeTenant(db, actor, organizationId, { roles: STAFF, action: 'organization.signers', targetType: 'Organization' });
  const [members, pending] = await Promise.all([
    db.organizationMember.findMany({
      where: { organizationId, role: { in: [...STAFF] } },
      orderBy: [{ role: 'desc' }, { id: 'asc' }],
      select: { role: true, roleLabel: true, user: { select: { id: true, name: true, twoFactorEnabled: true, gdprAnonymizedAt: true } } }
    }),
    listPendingCosignerInvitations(db, organizationId)
  ]);
  const signers = members
    .filter((member) => member.user.gdprAnonymizedAt === null)
    .map((member) => ({ userId: member.user.id, name: member.user.name, role: member.role as (typeof STAFF)[number], roleLabel: member.roleLabel, status: (member.user.twoFactorEnabled ? 'ACTIVE' : 'NEEDS_TWO_FACTOR') as SignerStatus }));
  // Invitaciones aún sin aceptar: la segunda firma no existe todavía, pero el panel dice a quién se ha invitado.
  // De quien aún no es miembro solo se usa lo que escribió quien invitó: nunca los datos de su cuenta (I4).
  const active = await db.user.findMany({ where: { id: { in: pending.map((invitation) => invitation.userId) }, gdprAnonymizedAt: null }, select: { id: true } });
  for (const invitation of pending) {
    if (!active.some((user) => user.id === invitation.userId) || signers.some((signer) => signer.userId === invitation.userId && signer.role === 'COSIGNER')) continue;
    signers.push({ userId: invitation.userId, name: invitation.displayName ?? '', role: 'COSIGNER', roleLabel: invitation.roleLabel, status: 'INVITED' });
  }
  return signers;
}
