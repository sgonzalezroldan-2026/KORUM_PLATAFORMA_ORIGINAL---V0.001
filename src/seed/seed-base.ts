import { normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import type { KorumPrismaClient } from '@/lib/prisma';
import type { InitiativeFundingPlan } from './funding-plan';
import type { KorumSeedData } from './seed-types';

/**
 * Datos de base de la semilla: reglas globales, usuarios, entidades con sus firmantes, iniciativas y comercios.
 * Todo con `upsert` sin actualización (`update: {}`): volver a ejecutar la semilla no pisa lo que ya exista.
 */

export const SEED_ACADEMIC_YEAR = '2026-2027';
/** Fecha de la revisión KYB de las entidades de la semilla. */
const KYB_REVIEWED_AT = new Date('2025-02-01T10:00:00.000Z');
export const SEED_ACTOR = 'seed';

export const SUPERADMIN_USER_ID = 'user-superadmin';
export const signerUserId = (organizationId: string, role: 'DIRECTOR' | 'COSIGNER') => `user-${organizationId.toLowerCase()}-${role.toLowerCase()}`;

/** Copia sin las claves indicadas (los datos de la semilla traen campos que no son columnas de la tabla). */
function omit<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

const canonical = normalizeCanonicalEmail;

export async function seedPlatformConfig(db: KorumPrismaClient, seed: KorumSeedData): Promise<void> {
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL', ...seed.globalRules }, update: {} });
  for (const tier of seed.medalsConfig) {
    await db.medalTierConfig.upsert({ where: { key: tier.key }, create: tier, update: {} });
  }
  for (const category of seed.globalCategories) {
    await db.globalCategory.upsert({
      where: { name: category.name },
      create: { name: category.name, icon: category.icon, rule: category.rule, sortOrder: category.sortOrder },
      update: {}
    });
  }
}

/** Usuarios (firmantes de cada entidad y Super-Admin de demostración), entidades, miembros y categorías propias. */
export async function seedOrganizations(db: KorumPrismaClient, seed: KorumSeedData): Promise<void> {
  await db.user.upsert({
    where: { id: SUPERADMIN_USER_ID },
    create: {
      id: SUPERADMIN_USER_ID,
      name: 'Super-Admin de demostración',
      email: 'superadmin@korum.example',
      canonicalEmail: 'superadmin@korum.example',
      emailVerified: true,
      emailVerifiedAt: KYB_REVIEWED_AT,
      isSuperadmin: true,
      twoFactorEnabled: true
    },
    update: {}
  });

  for (const org of seed.schools) {
    for (const signer of org.signers) {
      const id = signerUserId(org.id, signer.role);
      await db.user.upsert({
        where: { id },
        create: {
          id,
          name: signer.name,
          email: signer.email,
          canonicalEmail: canonical(signer.email),
          emailVerified: true,
          emailVerifiedAt: KYB_REVIEWED_AT,
          twoFactorEnabled: true,
          locale: org.contentLocale,
          provinceCode: org.provinceCode,
          activeOrganizationId: org.id
        },
        update: {}
      });
    }

    const { signers, customCategories } = org;
    const columns = omit(org, ['signers', 'customCategories', 'categoryRuleOverrides', 'participationGroups', 'logoUrl', 'bannerUrl']);
    await db.organization.upsert({
      where: { id: org.id },
      create: {
        ...columns,
        paycometSplitId: `mock-split-${org.slug}`,
        kybReviewedAt: KYB_REVIEWED_AT,
        kybReviewedById: SUPERADMIN_USER_ID,
        ley49VerifiedAt: org.ley49 ? KYB_REVIEWED_AT : null,
        quotaPeriod: SEED_ACADEMIC_YEAR,
        medalGrantUsedInTitle: org.medalGrantUsedInTitle ?? null
      },
      update: {}
    });

    for (const signer of signers) {
      await db.organizationMember.upsert({
        where: { userId_organizationId_role: { userId: signerUserId(org.id, signer.role), organizationId: org.id, role: signer.role } },
        create: { userId: signerUserId(org.id, signer.role), organizationId: org.id, role: signer.role, roleLabel: signer.roleLabel },
        update: {}
      });
    }
    for (const category of customCategories) {
      await db.organizationCategory.upsert({
        where: { organizationId_name: { organizationId: org.id, name: category.name } },
        create: { organizationId: org.id, name: category.name, icon: category.icon, rule: category.rule, isCustom: true },
        update: {}
      });
    }
  }
}

const dayMs = 86_400_000;

/** Iniciativas (con su número fijo de la semilla), fecha de su primer cobro y progreso por curso. */
export async function seedInitiatives(db: KorumPrismaClient, seed: KorumSeedData, plans: InitiativeFundingPlan[]): Promise<void> {
  for (const initiative of seed.initiatives) {
    const plan = plans.find((candidate) => candidate.initiativeId === initiative.id);
    const closesAt = new Date(initiative.closesAt);
    const createdAt = new Date(closesAt.getTime() - 55 * dayMs);
    const columns = omit(initiative, ['courses', 'schoolName', 'province', 'coverImage', 'beforeImage', 'afterImage', 'thanksMessage']);

    await db.initiative.upsert({
      where: { id: initiative.id },
      create: {
        ...columns,
        thanksMessage: initiative.thanksMessage ?? null,
        matchingSponsorName: initiative.matchingSponsorName ?? null,
        closesAt,
        createdAt,
        firstPayinAt: plan?.firstPayinAt ?? null,
        // Las 8 campañas de la semilla están publicadas: reservaron sus cupos en su curso. Cancelar una del curso actual los
        // devuelve a la entidad; una de un curso pasado cierra la reserva sin abonar nada (`releaseInitiativeQuotas`).
        quotaReservedAt: createdAt,
        quotaReservedExemptCents: initiative.defaultExemptAppliedCents,
        quotaReservedMedalCents: initiative.medalExemptAppliedCents,
        quotaReservedMaintCents: initiative.maintFeeCents,
        quotaReservedPeriod: initiative.academicYear
      },
      update: {}
    });
    await db.initiativeCourseProgress.createMany({
      data: initiative.courses.map((course) => ({ initiativeId: initiative.id, groupName: course.groupName, familiesCount: course.familiesCount })),
      skipDuplicates: true
    });
  }
}

/** Comercios amigos. El cobro de los aprobados lo registra `seed-funding`; aquí solo la ficha del comercio. */
export async function seedSponsors(db: KorumPrismaClient, seed: KorumSeedData, plans: InitiativeFundingPlan[]): Promise<void> {
  for (const sponsor of seed.sponsors) {
    const plan = plans.find((candidate) => candidate.initiativeId === sponsor.initiativeId);
    const paidAt =
      plan?.payments.find((payment) => payment.sponsorId === sponsor.id)?.createdAt ?? plan?.poolPayins.find((payin) => payin.sponsorId === sponsor.id)?.paidAt ?? null;
    const columns = omit(sponsor, ['initiativeTitle', 'expiresAt']);
    await db.sponsor.upsert({
      where: { id: sponsor.id },
      create: { ...columns, isMatchingPool: sponsor.isMatchingPool ?? false, expiresAt: new Date(sponsor.expiresAt), paidAt },
      update: {}
    });
  }
}

/** Tras insertar filas con `id` fijo, la secuencia debe continuar después del mayor para que las altas nuevas no choquen. */
export async function resetSequences(db: KorumPrismaClient, schema: string): Promise<void> {
  const tables: Array<[string, Promise<{ _max: { id: number | null } }>]> = [
    ['Initiative', db.initiative.aggregate({ _max: { id: true } })],
    ['Sponsor', db.sponsor.aggregate({ _max: { id: true } })],
    ['Idea', db.idea.aggregate({ _max: { id: true } })]
  ];
  for (const [table, aggregate] of tables) {
    const max = (await aggregate)._max.id ?? 1;
    await db.$queryRawUnsafe(`SELECT setval(pg_get_serial_sequence(format('%I.%I', $1::text, $2::text), 'id'), $3::bigint)`, schema, table, max);
  }
}
