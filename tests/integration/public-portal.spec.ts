import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { academicYearFor } from '@/core/finance/academic-year';
import type { KorumPrismaClient } from '@/lib/prisma';
import {
  getIndexingFacts,
  getPassForView,
  getPublicImpact,
  getPublicInitiative,
  getPublicInitiativeCard,
  getPublicOrganization,
  listIndexableInitiatives,
  listIndexableOrganizations,
  listPricingFacts,
  listPublicInitiatives
} from '@/repositories/public.repository';
import { ResourceNotFoundError } from '@/repositories/tenant-guard';
import { createInitiative, createOrganization, createTestClient, uniqueId } from './test-database';

/**
 * Portal público de familias (Sprint 3.3): las lecturas del Entorno 1 solo devuelven iniciativas públicas de **su** entidad, solo campos
 * pensados para serlo, y el sitemap nunca incluye a quien no acepta indexarse (QA-F02, QA-F03, QA-SEO03).
 */

let db: KorumPrismaClient;
const NOW = new Date();
const COURSE = academicYearFor(NOW);
let a: { id: string; slug: string };
let b: { id: string; slug: string };
let hidden: { id: string; slug: string };
let unverified: { id: string; slug: string };
let archived: { id: string; slug: string };
const ids: Record<string, number> = {};

beforeAll(async () => {
  db = createTestClient();
  const base = (overrides = {}) => ({ cif: uniqueId('G'), iban: 'ES91 2100 0418 4502 0005 1332', kybStatus: 'VERIFIED' as const, ...overrides });
  a = await createOrganization(db, base({ name: 'Colegio Portal A', vertical: 'SCHOOL' }));
  b = await createOrganization(db, base({ name: 'Colegio Portal B', vertical: 'SCHOOL' }));
  hidden = await createOrganization(db, base({ name: 'Colegio Portal Oculto', publicIndexing: false }));
  unverified = await createOrganization(db, base({ name: 'Colegio Portal Sin verificar', kybStatus: 'PENDING' }));
  archived = await createOrganization(db, base({ name: 'Colegio Portal Archivado', archivedAt: new Date() }));

  const make = (key: string, organizationId: string, overrides: Parameters<typeof createInitiative>[2] = {}) =>
    createInitiative(db, organizationId, { academicYear: COURSE, ...overrides }).then((row) => {
      ids[key] = row.id;
    });
  await make('aFund', a.id, { status: 'FUNDRAISING', raisedCents: 100_000, totalContributions: 4, title: 'Abierta A', matchingPoolRemainingCents: 5_000 });
  await make('aFund2', a.id, { status: 'FUNDRAISING', raisedCents: 20_000, title: 'Abierta A2' });
  await make('aReached', a.id, { status: 'GOAL_REACHED', raisedCents: 583_300, title: 'Conseguida A' });
  await make('aClosed', a.id, { status: 'CLOSED', raisedCents: 583_300, academicYear: '2020-2021', title: 'Cerrada A' });
  await make('aDraft', a.id, { status: 'BUDGETING', raisedCents: 999, title: 'Borrador A' });
  await make('aCancelled', a.id, { status: 'CANCELLED', raisedCents: 777, title: 'Cancelada A' });
  await make('bFund', b.id, { status: 'FUNDRAISING', raisedCents: 50_000, title: 'Abierta B' });
  await make('hiddenFund', hidden.id, { status: 'FUNDRAISING', title: 'Abierta oculta' });
  await make('unverifiedFund', unverified.id, { status: 'FUNDRAISING', title: 'Abierta sin verificar' });
  await make('archivedFund', archived.id, { status: 'FUNDRAISING', title: 'Abierta archivada' });
  await db.initiativeCourseProgress.createMany({
    data: [
      { initiativeId: ids.aFund!, groupName: '3º de Primaria', familiesCount: 28 },
      { initiativeId: ids.aFund!, groupName: '4º de Primaria', familiesCount: 0 }
    ]
  });
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
});

describe('QA-F02 · solo las iniciativas en recaudación de su entidad', () => {
  it('el listado devuelve únicamente FUNDRAISING de esa entidad', async () => {
    const list = await listPublicInitiatives(db, a.slug);
    expect(list.map((item) => item.id).sort()).toEqual([ids.aFund!, ids.aFund2!].sort());
    expect(list.every((item) => item.status === 'FUNDRAISING')).toBe(true);
  });

  it('una entidad archivada o inexistente no lista nada', async () => {
    expect(await listPublicInitiatives(db, archived.slug)).toEqual([]);
    expect(await listPublicInitiatives(db, 'no-existe-esta-entidad')).toEqual([]);
  });

  it('solo expone campos públicos: ni la entidad propietaria, ni el PIN, ni el identificador del pedido, ni el coste interno de tramos de otros', async () => {
    const [first] = await listPublicInitiatives(db, a.slug);
    const keys = Object.keys(first ?? {});
    for (const forbidden of ['organizationId', 'gatePinHash', 'gatePinExpiresAt', 'paycometEscrowOrderId', 'firstPayinAt', 'maintFeeCents', 'gatewayFeeCents', 'quotaReservedExemptCents', 'thanksMessage']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    expect(JSON.stringify(first)).not.toMatch(/@|donorTaxId|guestEmail|iban/i);
  });

  it('lleva los grupos con familias del reto, sin datos de personas', async () => {
    const detail = await getPublicInitiative(db, a.slug, ids.aFund!);
    expect(detail.courses).toEqual(expect.arrayContaining([{ groupName: '3º de Primaria', familiesCount: 28 }]));
    expect(Object.keys(detail.courses[0] ?? {}).sort()).toEqual(['familiesCount', 'groupName']);
  });
});

describe('QA-F03 · ficha pública y aislamiento entre entidades', () => {
  it('abre iniciativas abiertas, conseguidas y cerradas de su entidad', async () => {
    for (const key of ['aFund', 'aReached', 'aClosed'] as const) {
      expect((await getPublicInitiative(db, a.slug, ids[key]!)).id).toBe(ids[key]);
    }
  });

  it('no abre borradores ni canceladas, ni la iniciativa de otra entidad, ni una inexistente: siempre el mismo 404', async () => {
    const attempts: Array<[string, number]> = [
      [a.slug, ids.aDraft!],
      [a.slug, ids.aCancelled!],
      [a.slug, ids.bFund!],
      [b.slug, ids.aFund!],
      [a.slug, 987_654_321],
      ['no-existe-esta-entidad', ids.aFund!],
      [archived.slug, ids.archivedFund!]
    ];
    for (const [slug, id] of attempts) {
      await expect(getPublicInitiative(db, slug, id), `${slug}/${id}`).rejects.toBeInstanceOf(ResourceNotFoundError);
    }
  });

  it('del contexto de la entidad solo salen el vertical, los grupos y las tarifas públicas de taquilla', async () => {
    const detail = await getPublicInitiative(db, a.slug, ids.aFund!);
    expect(Object.keys(detail.organization).sort()).toEqual(['participationGroupsJson', 'ticketFeeBps', 'ticketFeeFixedCents', 'vertical']);
  });

  it('la entidad pública no devuelve CIF, IBAN, correos ni teléfono', async () => {
    const organization = await getPublicOrganization(db, a.slug);
    expect(Object.keys(organization)).not.toEqual(expect.arrayContaining(['cif']));
    for (const forbidden of ['cif', 'iban', 'contactEmail', 'contactPhone', 'paycometSplitId', 'walletId', 'exemptRemainingCents', 'medalGrantAvailableCents']) {
      expect(Object.keys(organization), forbidden).not.toContain(forbidden);
    }
    await expect(getPublicOrganization(db, archived.slug)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe('datos internos de la pizarra: solo para derivar hechos públicos, siempre junto a su entidad', () => {
  it('devuelve la pizarra de las iniciativas públicas de esa entidad y nada de otras ni de borradores', async () => {
    const facts = await listPricingFacts(db, a.slug, [ids.aFund!, ids.aDraft!, ids.aCancelled!, ids.bFund!]);
    expect(facts.map((fact) => fact.id)).toEqual([ids.aFund!]);
    expect(Object.keys(facts[0]!).sort()).toEqual(['bracketFeeCents', 'contingencyBps', 'costInstCents', 'costMatCents', 'id', 'maintFeeCents', 'quotaReservedAt']);
    expect(await listPricingFacts(db, b.slug, [ids.aFund!])).toEqual([]);
    expect(await listPricingFacts(db, archived.slug, [ids.archivedFund!])).toEqual([]);
    expect(await listPricingFacts(db, a.slug, [])).toEqual([]);
  });

  it('el estado del KYB sale solo de su función aparte, nunca de la vista pública de la entidad', async () => {
    expect(await getIndexingFacts(db, a.slug)).toEqual({ publicIndexing: true, kybStatus: 'VERIFIED' });
    expect(await getIndexingFacts(db, unverified.slug)).toMatchObject({ kybStatus: 'PENDING' });
    await expect(getIndexingFacts(db, archived.slug)).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(Object.keys(await getPublicOrganization(db, a.slug))).not.toContain('kybStatus');
  });
});

describe('QA-F02 · tarjeta social por identificador', () => {
  it('solo sirve iniciativas públicas de entidades no archivadas', async () => {
    expect((await getPublicInitiativeCard(db, ids.aFund!)).organization.name).toBe('Colegio Portal A');
    expect((await getPublicInitiativeCard(db, ids.aClosed!)).id).toBe(ids.aClosed);
    for (const key of ['aDraft', 'aCancelled', 'archivedFund'] as const) {
      await expect(getPublicInitiativeCard(db, ids[key]!), key).rejects.toBeInstanceOf(ResourceNotFoundError);
    }
    await expect(getPublicInitiativeCard(db, 987_654_321)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('no incluye importes de la pizarra interna ni identificadores internos', async () => {
    const card = await getPublicInitiativeCard(db, ids.aFund!);
    expect(Object.keys(card)).not.toEqual(expect.arrayContaining(['costMatCents', 'organizationId', 'walletEscrowId']));
  });
});

describe('barra de impacto de la portada', () => {
  it('suma lo recaudado en el curso vigente solo de las iniciativas públicas de esa entidad y cuenta las mejoras logradas de siempre', async () => {
    const impact = await getPublicImpact(db, a.slug, NOW);
    // 100.000 + 20.000 (abiertas) + 583.300 (conseguida): el borrador, la cancelada y la de otro curso no suman.
    expect(impact.raisedCents).toBe(100_000 + 20_000 + 583_300);
    expect(impact.academicYear).toBe(COURSE);
    // Conseguida + cerrada (aunque sea de otro curso).
    expect(impact.achievementsCount).toBe(2);
  });

  it('una entidad sin iniciativas, o inexistente, suma cero', async () => {
    expect(await getPublicImpact(db, 'no-existe-esta-entidad', NOW)).toMatchObject({ raisedCents: 0, achievementsCount: 0 });
  });

  it('no mezcla a otra entidad', async () => {
    expect((await getPublicImpact(db, b.slug, NOW)).raisedCents).toBe(50_000);
  });
});

describe('QA-SEO03 · qué entra en el sitemap', () => {
  it('solo portadas de entidades verificadas, no archivadas y que aceptan indexarse', async () => {
    const slugs = (await listIndexableOrganizations(db)).map((organization) => organization.slug);
    expect(slugs).toEqual(expect.arrayContaining([a.slug, b.slug]));
    for (const excluded of [hidden, unverified, archived]) expect(slugs).not.toContain(excluded.slug);
  });

  it('solo iniciativas públicas de esas entidades', async () => {
    const found = await listIndexableInitiatives(db);
    const foundIds = found.map((initiative) => initiative.id);
    expect(foundIds).toEqual(expect.arrayContaining([ids.aFund!, ids.aReached!, ids.aClosed!, ids.bFund!]));
    for (const key of ['aDraft', 'aCancelled', 'hiddenFund', 'unverifiedFund', 'archivedFund'] as const) expect(foundIds, key).not.toContain(ids[key]);
    expect(found.find((initiative) => initiative.id === ids.aFund)?.organization.slug).toBe(a.slug);
  });

  it('desactivar publicIndexing saca a la entidad y a sus iniciativas del sitemap en el acto', async () => {
    await db.organization.update({ where: { id: b.id }, data: { publicIndexing: false } });
    try {
      expect((await listIndexableOrganizations(db)).map((organization) => organization.slug)).not.toContain(b.slug);
      expect((await listIndexableInitiatives(db)).map((initiative) => initiative.id)).not.toContain(ids.bFund);
    } finally {
      await db.organization.update({ where: { id: b.id }, data: { publicIndexing: true } });
    }
  });
});

describe('pase del invitado: lectura acotada a su entidad', () => {
  let pass: { uuid: string; serialCode: string };

  beforeAll(async () => {
    const contribution = await db.contribution.create({
      data: {
        organizationId: a.id,
        initiativeId: ids.aFund!,
        fiscalYear: NOW.getUTCFullYear(),
        type: 'TICKET',
        amountCents: 500,
        totalChargedCents: 555,
        paymentMethod: 'CARD',
        status: 'COMPLETED',
        guestEmail: 'comprador.privado@familia.example',
        canonicalEmail: 'comprador.privado@familia.example'
      }
    });
    pass = await db.ticketPass.create({
      data: { contributionId: contribution.id, initiativeId: ids.aFund!, serialCode: uniqueId('KT'), holderEmail: 'comprador.privado@familia.example', qrHmacSignature: 'firma-de-prueba' },
      select: { uuid: true, serialCode: true }
    });
  });

  it('lo devuelve junto a su entidad, sin el email de quien compró', async () => {
    const found = await getPassForView(db, a.slug, pass.uuid);
    expect(found).toMatchObject({ uuid: pass.uuid, serialCode: pass.serialCode, quantity: 1, revokedAt: null });
    expect(JSON.stringify(found)).not.toMatch(/comprador\.privado|@/);
    expect(found?.initiative.organization.name).toBe('Colegio Portal A');
  });

  it('con otra entidad, una archivada o un código inventado responde lo mismo que si no existiera', async () => {
    expect(await getPassForView(db, b.slug, pass.uuid)).toBeNull();
    expect(await getPassForView(db, archived.slug, pass.uuid)).toBeNull();
    expect(await getPassForView(db, a.slug, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
