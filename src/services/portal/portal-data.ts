import { notFound } from 'next/navigation';
import { cache } from 'react';
import { compareForCatalog, type VisibleHuchaMode } from '@/core/public/catalog';
import { findGroupBySlug, orderedGroupNames, groupSlug } from '@/core/public/course-challenge';
import { localizeRow, toCardData, toDetailData, type InitiativeCardData, type InitiativeDetailData, type InitiativeRow } from '@/core/public/view-model';
import { getPrisma } from '@/lib/prisma';
import { isIndexable } from '@/lib/seo/indexing';
import { getIndexingFacts, getPublicImpact, getPublicInitiative, isSelfBoostShown, getPublicOrganization, listPricingFacts, listPublicInitiatives } from '@/repositories/public.repository';
import { findSponsorableInitiative, listFriendlySponsors } from '@/repositories/sponsorship.repository';
import { ResourceNotFoundError } from '@/repositories/tenant-guard';
import { getSetting } from '@/services/settings/settings.service';

/**
 * Datos del portal público (Entorno 1) listos para pintar. Las páginas y el `layout` comparten la lectura de la entidad con `cache()` de React
 * (una sola consulta por petición). Todo lo que sale de aquí es público y serializable; el `layout` resuelve antes de enviar nada si la entidad
 * existe, para que una URL inexistente responda un `404` de verdad.
 */

/**
 * La entidad del portal. Una entidad que no existe (o está archivada) es un `404` de verdad: se convierte aquí, para que ni el `layout`, ni la
 * página, ni `generateMetadata` (que se ejecutan a la vez) puedan dejar escapar un error y responder `500`.
 */
export const loadPortalOrganization = cache(async (slug: string) => {
  try {
    const db = getPrisma();
    const [organization, indexing] = await Promise.all([getPublicOrganization(db, slug), getIndexingFacts(db, slug)]);
    // `indexable` es el único dato que sale del KYB hacia las páginas: el estado en sí no es público.
    return { ...organization, indexable: isIndexable(indexing) };
  } catch (error) {
    if (error instanceof ResourceNotFoundError) notFound();
    throw error;
  }
});

/** Modo de Mi Hucha que fija el Super-Admin. `DISABLED` (o cualquier fallo al leerlo) la oculta: nunca se enseña una Hucha que no funciona. */
export async function loadHuchaMode(): Promise<VisibleHuchaMode | null> {
  try {
    const mode = await getSetting(getPrisma(), 'hucha.mode');
    return mode === 'PLEDGE' || mode === 'REGULATED_WALLET' ? mode : null;
  } catch {
    return null;
  }
}

/** Une los campos públicos de una iniciativa con los datos internos que el servidor necesita para derivar el desglose y el sello de comisión. */
function withPricingFacts<T extends object>(row: T, fact: Awaited<ReturnType<typeof listPricingFacts>>[number] | undefined): InitiativeRow & T {
  return { ...row, costMatCents: fact?.costMatCents ?? 0, costInstCents: fact?.costInstCents ?? 0, contingencyBps: fact?.contingencyBps ?? 0, bracketFeeCents: fact?.bracketFeeCents ?? 0, maintFeeCents: fact?.maintFeeCents ?? 0, quotaReservedAt: fact?.quotaReservedAt ?? null } as InitiativeRow & T;
}

export interface PortalHomeData {
  cards: InitiativeCardData[];
  contentLang: string | undefined;
  groups: { slug: string; name: string }[];
  impact: { academicYear: string; raisedCents: number; achievementsCount: number };
  huchaMode: VisibleHuchaMode | null;
}

export async function loadPortalHome(slug: string, locale: string, now: Date): Promise<PortalHomeData> {
  const db = getPrisma();
  const organization = await loadPortalOrganization(slug);
  const [publicRows, impact, huchaMode] = await Promise.all([listPublicInitiatives(db, slug), getPublicImpact(db, slug, now), loadHuchaMode()]);
  const facts = new Map((await listPricingFacts(db, slug, publicRows.map((row) => row.id))).map((fact) => [fact.id, fact]));
  const rows = publicRows.map((row) => withPricingFacts(row, facts.get(row.id)));
  const cards = rows
    .map((row) => ({ row, localized: localizeRow(row, locale, organization.contentLocale) }))
    .sort((a, b) => compareForCatalog(a.row, b.row))
    .map(({ localized }) => toCardData(localized.row, now, organization));
  const hasChallenge = rows.some((row) => row.rewardEnabled);
  const groups = hasChallenge ? orderedGroupNames(organization.vertical, organization.participationGroupsJson).map((name) => ({ slug: groupSlug(name), name })) : [];
  return {
    cards,
    contentLang: organization.contentLocale === locale ? undefined : organization.contentLocale,
    groups,
    impact,
    huchaMode
  };
}

export interface InitiativePageData {
  detail: InitiativeDetailData;
  contentLang: string | undefined;
  groups: { slug: string; name: string }[];
  updatedAt: Date;
  /** Grupo pedido con `?grupo=` si existe y ya suma familias; nunca texto de la URL. */
  groupSlug: string | null;
  rawDescription: string;
  title: string;
  /** ¿La ficha dice que la plataforma KORUM ayudó a conseguir la meta? Solo si se decidió mostrarlo; nunca lleva importe. */
  selfBoostShown: boolean;
}

/** Una lectura por petición: `generateMetadata` y la página comparten el resultado. `requestedGroup` es `''` si no se pidió ninguno. */
export const loadInitiativePage = cache(async (slug: string, initiativeId: number, locale: string, requestedGroup: string): Promise<InitiativePageData> => {
  const now = new Date();
  const db = getPrisma();
  const organization = await loadPortalOrganization(slug);
  const row = await getPublicInitiative(db, slug, initiativeId);
  const { organization: context, ...publicFields } = row;
  const [[fact], selfBoostShown] = await Promise.all([listPricingFacts(db, slug, [initiativeId]), isSelfBoostShown(db, initiativeId)]);
  const rest = withPricingFacts(publicFields, fact);
  const localized = localizeRow(rest, locale, organization.contentLocale);
  const detail = toDetailData(localized.row, { vertical: context.vertical, participationGroupsJson: context.participationGroupsJson, ticketFeeFixedCents: context.ticketFeeFixedCents, ticketFeeBps: context.ticketFeeBps }, now);
  const names = rest.rewardEnabled ? orderedGroupNames(context.vertical, context.participationGroupsJson) : [];
  const match = findGroupBySlug(rest.courses, requestedGroup || null);
  return {
    detail,
    contentLang: localized.lang,
    groups: names.map((name) => ({ slug: groupSlug(name), name })),
    updatedAt: row.updatedAt,
    groupSlug: match ? groupSlug(match.groupName) : null,
    rawDescription: localized.row.description,
    title: localized.row.title,
    selfBoostShown
  };
});

/** Comercios amigos aprobados y vigentes de la entidad, y la iniciativa a la que un comercio nuevo podría patrocinar (si hay alguna). */
export async function loadSponsorDirectory(slug: string, now: Date) {
  const db = getPrisma();
  const [sponsors, sponsorable] = await Promise.all([listFriendlySponsors(db, slug, now), findSponsorableInitiative(db, slug, now)]);
  return { sponsors, sponsorableInitiativeId: sponsorable?.id ?? null };
}
