import { academicYearFor } from '@/core/finance/academic-year';
import { renewOrganizationQuotas } from '@/core/finance/quota-reservation';
import { bracketConfigFor } from '@/core/finance/tco.service';
import { TICKETING_CATEGORY, type StudioVertical } from '@/core/studio/studio-draft';
import type { StudioCategory, StudioContext } from '@/core/studio/studio-board';
import type { Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { requireOwnedResource } from './ownership';
import { authorizeTenant, ResourceNotFoundError, type SessionActor } from './tenant-guard';

/**
 * Lecturas del Estudio de edición (Sprint 4.3). Cada función autoriza primero (`DIRECTOR` o `COSIGNER` de **esa** entidad, `AuditLog` si se deniega)
 * y elige los campos uno a uno: ni el PIN de portería ni los datos de las personas llegan a la pantalla. Las reglas (tramos, pasarela, mantenimiento) y
 * los cupos salen siempre de la base de datos: el navegador nunca aporta una cifra con la que se calcule.
 */

const STAFF = ['DIRECTOR', 'COSIGNER'] as const;

/** Tope de borradores abiertos por entidad: cada iniciativa es permanente (sus enlaces y su hucha no se borran), así que no se admiten sin límite. */
export const MAX_OPEN_DRAFTS = 20;

/** Lo que el Estudio muestra y edita de una iniciativa. `gatePinHash` y el resto de campos internos quedan fuera. */
const STUDIO_INITIATIVE_VIEW = {
  id: true,
  walletEscrowId: true,
  format: true,
  status: true,
  title: true,
  category: true,
  stage: true,
  closesAt: true,
  description: true,
  academicYear: true,
  goalCents: true,
  raisedCents: true,
  costMatCents: true,
  costInstCents: true,
  contingencyBps: true,
  showPublicBreakdown: true,
  plaqueEnabled: true,
  rewardEnabled: true,
  rewardText: true,
  targetFamiliesPerCourse: true,
  defaultExemptAppliedCents: true,
  medalExemptAppliedCents: true,
  bracketRateAppliedBps: true,
  bracketFeeCents: true,
  maintFeeCents: true,
  gatewayFeeCents: true,
  ticketSubtype: true,
  ticketPriceCents: true,
  ticketMax: true,
  ticketsSold: true,
  ticketFeeMode: true,
  ticketVenue: true,
  rafflePrizeCount: true,
  coverFileId: true,
  sourceIdeaId: true
} as const;

export type StudioInitiative = NonNullable<Awaited<ReturnType<typeof findStudioInitiative>>>;

async function findStudioInitiative(db: Db, organizationId: string, initiativeId: number) {
  return db.initiative.findFirst({ where: { id: initiativeId, organizationId }, select: STUDIO_INITIATIVE_VIEW });
}

/**
 * Reglas y cupos con los que se calcula la pizarra. Lo usan el panel (para pintarla) y el servicio (para guardar y publicar), por eso recibe un `Db` ya
 * autorizado: quien llama es responsable de haber pasado la guardia de esa entidad.
 */
export async function loadStudioContext(db: Db, organizationId: string): Promise<StudioContext & { organizationName: string; contentLocale: 'es' | 'ca' | 'en'; slug: string }> {
  const [organization, global, globalCategories, customCategories] = await Promise.all([
    db.organization.findUnique({
      where: { id: organizationId },
      select: {
        name: true,
        slug: true,
        vertical: true,
        contentLocale: true,
        kybStatus: true,
        customRules: true,
        t1Bps: true,
        t2Bps: true,
        t3Bps: true,
        exemptRemainingCents: true,
        medalGrantAvailableCents: true,
        medalRank: true,
        maintActive: true,
        maintPerInitCents: true,
        maintAnnualCapCents: true,
        maintPaidCents: true,
        ticketFeeFixedCents: true,
        ticketFeeBps: true,
        donationPresetsCents: true,
        defaultDonationIdx: true
      }
    }),
    db.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' } }),
    db.globalCategory.findMany({ select: { name: true, icon: true, rule: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    db.organizationCategory.findMany({ where: { organizationId }, select: { name: true, icon: true, rule: true }, orderBy: { id: 'asc' } })
  ]);
  if (!organization) throw new ResourceNotFoundError('Entidad');

  // Una categoría propia con el mismo nombre que una global manda sobre ella, como en el prototipo (`getEffectiveCategoriesForSchool`).
  const byName = new Map<string, StudioCategory>();
  for (const category of [...globalCategories, ...customCategories]) byName.set(category.name, { name: category.name, icon: category.icon, rule: category.rule });
  const categories = [...byName.values()];
  if (!byName.has(TICKETING_CATEGORY)) categories.push({ name: TICKETING_CATEGORY, icon: '🎟️', rule: 'EXEMPT' });

  return {
    organizationName: organization.name,
    slug: organization.slug,
    contentLocale: organization.contentLocale,
    vertical: organization.vertical as StudioVertical,
    bracket: bracketConfigFor(global, organization),
    gateway: { pctBps: global.gatewayPctBps, fixedCents: global.gatewayFixedCents },
    donationTicketCents: organization.donationPresetsCents[organization.defaultDonationIdx] ?? 2500,
    exemptRemainingCents: organization.exemptRemainingCents,
    medalGrantAvailableCents: organization.medalGrantAvailableCents,
    medalRank: organization.medalRank,
    maint: { active: organization.maintActive, perInitCents: organization.maintPerInitCents, annualCapCents: organization.maintAnnualCapCents, paidCents: organization.maintPaidCents },
    ticketFee: { fixedCents: organization.ticketFeeFixedCents, pctBps: organization.ticketFeeBps },
    maxCampaignDays: global.maxCampaignDays,
    categories,
    kybVerified: organization.kybStatus === 'VERIFIED'
  };
}

/**
 * Cupos al día antes de calcular: al cambiar de curso la publicación renueva el exento de la entidad (`reserveInitiativeQuotas`), así que una pizarra
 * calculada con el del curso anterior cobraría comisión sobre un exento que está a punto de renovarse (auditoría financiera del 4.3). La renovación es
 * idempotente y deja su rastro; una entidad sin curso asignado se queda como está. `db` ya debe haber pasado la guardia de esa entidad.
 */
export async function loadFreshStudioContext(db: Db, organizationId: string, now: Date) {
  const organization = await db.organization.findUnique({ where: { id: organizationId }, select: { quotaPeriod: true } });
  if (organization?.quotaPeriod) await renewOrganizationQuotas(db, organizationId, academicYearFor(now));
  return loadStudioContext(db, organizationId);
}

/** Contexto del Estudio y lista de iniciativas de la entidad (las más recientes primero) para el selector. */
export async function getStudioOverview(db: KorumPrismaClient, actor: SessionActor, organizationId: string) {
  await authorizeTenant(db, actor, organizationId, { roles: STAFF, action: 'studio.overview', targetType: 'Initiative' });
  const context = await loadFreshStudioContext(db, organizationId, new Date());
  const [initiatives, openDrafts] = await Promise.all([
    db.initiative.findMany({ where: { organizationId }, orderBy: { id: 'desc' }, select: { id: true, walletEscrowId: true, title: true, format: true, status: true } }),
    db.initiative.count({ where: { organizationId, status: 'BUDGETING' } })
  ]);
  return { context, initiatives, canCreate: openDrafts < MAX_OPEN_DRAFTS };
}

/** Una iniciativa de la entidad para editarla: 404 uniforme si es de otra (y queda registrado el intento). */
export async function getStudioInitiative(db: KorumPrismaClient, actor: SessionActor, organizationId: string, initiativeId: number): Promise<StudioInitiative> {
  await authorizeTenant(db, actor, organizationId, { roles: STAFF, action: 'studio.initiative_get', targetType: 'Initiative', targetId: initiativeId });
  // Un identificador que no cabe en la base de datos responde igual que uno inexistente (y no un error del servidor).
  if (!Number.isSafeInteger(initiativeId) || initiativeId < 1 || initiativeId > 2_147_483_647) throw new ResourceNotFoundError('Iniciativa');
  const owner = await db.initiative.findUnique({ where: { id: initiativeId }, select: { organizationId: true } });
  await requireOwnedResource(db, actor, { organizationId, resourceType: 'Initiative', resourceId: initiativeId, resourceLabel: 'Iniciativa', ownerOrganizationId: owner?.organizationId ?? null });
  const initiative = await findStudioInitiative(db, organizationId, initiativeId);
  if (!initiative) throw new ResourceNotFoundError('Iniciativa');
  return initiative;
}

/** Lo que necesita el cartel: la iniciativa, el nombre y el logotipo de la entidad y su idioma de contenido. */
export async function getPosterData(db: KorumPrismaClient, actor: SessionActor, organizationId: string, initiativeId: number) {
  const initiative = await getStudioInitiative(db, actor, organizationId, initiativeId);
  const organization = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true, slug: true, contentLocale: true, logoFileId: true, brandPrimary: true } });
  return { initiative: { id: initiative.id, title: initiative.title, status: initiative.status, walletEscrowId: initiative.walletEscrowId, format: initiative.format, ticketSubtype: initiative.ticketSubtype }, organization };
}
