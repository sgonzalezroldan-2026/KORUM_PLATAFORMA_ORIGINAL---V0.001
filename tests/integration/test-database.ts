import { inject } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { createPrismaClient, type KorumPrismaClient } from '@/lib/prisma';
import { TEST_SCHEMA } from './test-schema';

export { TEST_SCHEMA };

/**
 * Cliente de la aplicación (con la extensión de solo-alta) apuntando al esquema de pruebas.
 * Con la base local de `npm run db:dev` (PGlite: un único proceso PostgreSQL para todas las conexiones), varias conexiones
 * simultáneas mezclan sus mensajes de protocolo (`08P01`), así que se usa una sola: las operaciones concurrentes se
 * solapan sentencia a sentencia y las ramas de carrera se siguen ejercitando. Con un PostgreSQL real (`TEST_DATABASE_URL`,
 * como en la CI) se usa el pool completo y la concurrencia es real.
 */
export function createTestClient(): KorumPrismaClient {
  const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
  return createPrismaClient({ connectionString: inject('testDatabaseUrl'), schema: TEST_SCHEMA, maxConnections: realPostgres ? undefined : 1 });
}

/** Nombre de tabla cualificado para el SQL escrito a mano de las pruebas. */
export const table = (name: string) => `"${TEST_SCHEMA}"."${name}"`;

let sequence = 0;

/** Identificador único por prueba: las pruebas no se limpian entre sí (el libro mayor no admite borrados). */
export function uniqueId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createOrganization(db: KorumPrismaClient, overrides: Partial<Prisma.OrganizationUncheckedCreateInput> = {}) {
  const id = uniqueId('org');
  return db.organization.create({
    data: {
      id,
      slug: id,
      name: 'CEIP de pruebas',
      legalName: 'AFA CEIP de pruebas',
      legalForm: 'PARENTS_ASSOCIATION',
      centerOwnership: 'PUBLIC',
      province: 'Barcelona',
      walletId: `WLT-${id}`,
      ...overrides
    }
  });
}

export function createUser(db: KorumPrismaClient, overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  const id = uniqueId('user');
  const email = `${id}@pruebas.example`;
  return db.user.create({ data: { id, name: 'Persona de pruebas', email, canonicalEmail: email, emailVerified: true, ...overrides } });
}

export function createInitiative(db: KorumPrismaClient, organizationId: string, overrides: Partial<Prisma.InitiativeUncheckedCreateInput> = {}) {
  return db.initiative.create({
    data: {
      walletEscrowId: uniqueId('WLT-ESC'),
      organizationId,
      academicYear: '2026-2027',
      title: 'Toldos para el patio',
      category: 'Patios y Deporte',
      stage: 'Recaudando',
      status: 'BUDGETING',
      closesAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      quarter: '2026-Q4',
      goalCents: 583_300,
      description: 'Iniciativa creada por las pruebas de integración',
      ...overrides
    }
  });
}
