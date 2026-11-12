import { inject } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { createKeyring } from '@/core/security/crypto';
import { markSessionReauthenticated, verifySuperadminSession } from '@/core/security/verified-actor';
import type { SessionActor } from '@/repositories/tenant-guard';
import { createPrismaClient, type KorumPrismaClient } from '@/lib/prisma';
import { PreviewEmailProvider } from '@/services/email/preview-email-provider';
import { MemoryStorage } from '@/services/storage/memory-storage';
import { TEST_SCHEMA } from './test-schema';

export { TEST_SCHEMA };

/**
 * Cliente de la aplicación (con la extensión de solo-alta) apuntando al esquema de pruebas.
 * Con la base local de `npm run db:dev` (PGlite: un único proceso PostgreSQL para todas las conexiones), varias conexiones
 * simultáneas mezclan sus mensajes de protocolo (`08P01`), así que se usa una sola: las operaciones concurrentes se
 * solapan sentencia a sentencia y las ramas de carrera se siguen ejercitando. Con un PostgreSQL real (`TEST_DATABASE_URL`,
 * como en la CI) se usa el pool completo y la concurrencia es real.
 */
/**
 * Con la base local sin Docker (una sola conexión) las transacciones simultáneas se ponen en cola: el límite de 2 s que Prisma da para
 * conseguir conexión es de un servidor con pool, no de este. Con PostgreSQL real (`TEST_DATABASE_URL`) se dejan los valores de producción.
 */
export function createTestClient(): KorumPrismaClient {
  const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
  return createPrismaClient({ connectionString: inject('testDatabaseUrl'), schema: TEST_SCHEMA, maxConnections: realPostgres ? undefined : 1, ...(realPostgres ? {} : { transactionOptions: { maxWait: 60_000, timeout: 120_000 } }) });
}

/** Llavero de las pruebas: una clave fija de 32 bytes, versión 1. */
export const TEST_KEYRING = createKeyring({ version: 1, key: Buffer.alloc(32, 9).toString('base64') });
export const TEST_HMAC_SECRET = 'integration-data-hmac-secret-0123456789';

/** Dependencias de las tareas que no mueven dinero: los proveedores de pago y facturación fallan si alguien los usa. */
export const testJobDeps = () => ({
  storageProvider: () => new MemoryStorage(),
  keyring: () => TEST_KEYRING,
  hmacSecret: () => TEST_HMAC_SECRET,
  outbox: {
    provider: async () => new PreviewEmailProvider({ writeFiles: false }),
    sender: async () => ({ fromAddress: 'no-responder@korum.test', fromName: 'KORUM' }),
    appUrl: () => 'https://korum.test',
    qrSecret: () => 'integration-qr-hmac-secret-0123456789ab'
  }
});

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

/**
 * Super-Admin con 2FA y una sesión que superó el TOTP hace un minuto respecto a `now`: lo que emite la capa de sesión (Sprint 3.2) para las
 * operaciones que exigen un `VerifiedSuperadminActor` (ajustes, secretos, resoluciones manuales de dinero y facturas).
 */
export async function verifiedSuperadmin(db: KorumPrismaClient, now: Date = new Date(), operation = 'test.operation') {
  const admin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
  const session = await db.session.create({ data: { id: uniqueId('ses'), token: uniqueId('tok'), userId: admin.id, expiresAt: new Date(now.getTime() + 3_600_000) } });
  await markSessionReauthenticated(db, session.id, { secondFactor: true }, new Date(now.getTime() - 60_000));
  const actor = await verifySuperadminSession(db, { userId: admin.id, sessionId: session.id, operation }, now);
  return { admin, session, actor };
}

const signerCache = new Map<string, SessionActor>();

/**
 * Una persona firmante **de verdad** (usuaria con su fila de cargo en la entidad), una por entidad y cargo. `setGatePin` vuelve a comprobar el cargo en la base de datos
 * dentro de la transacción (auditoría de seguridad del 5.2, H1): un actor inventado, sin fila, ya no basta.
 */
export async function signerOf(db: KorumPrismaClient, organizationId: string, role: 'DIRECTOR' | 'COSIGNER' = 'DIRECTOR'): Promise<SessionActor> {
  const key = `${organizationId}:${role}`;
  const cached = signerCache.get(key);
  if (cached) return cached;
  // Si la entidad ya tiene a esa persona (la prueba la creó), se usa: no se añade una firmante más que cambiaría quién recibe los avisos.
  const existing = await db.organizationMember.findFirst({ where: { organizationId, role }, select: { userId: true } });
  const userId = existing?.userId ?? (await (async () => { const user = await createUser(db, { twoFactorEnabled: true }); await db.organizationMember.create({ data: { organizationId, userId: user.id, role } }); return user.id; })());
  const actor: SessionActor = { kind: 'user', userId, isSuperadmin: false, memberships: [{ organizationId, role }], secondFactor: true };
  signerCache.set(key, actor);
  return actor;
}
