import type { Prisma } from '@/generated/prisma/client';
import { pendingAccessCodesWhere } from '@/lib/auth/access-codes';
import { inTransaction, type Db } from '@/lib/db';
import { writeAudit } from '@/services/audit/audit.service';
import { daysBefore, RETENTION } from './retention-policy';

/**
 * Pasos de `DATA_RETENTION_PURGE` que **borran o vacían** lo que ya no hace falta (Sprint 5.10b, tabla de plazos §3.3, §3.4 y §3.10). Como el resto de la tarea, cada
 * paso trata como mucho un lote y devuelve cuántas filas trató.
 */

/** Alertas de operación resueltas hace más de 12 meses (§3.10). Una abierta no se borra nunca. */
export async function purgeResolvedOpsAlerts(db: Db, now: Date, limit: number): Promise<number> {
  const rows = await db.opsAlert.findMany({ where: { status: 'RESOLVED', resolvedAt: { lt: daysBefore(now, RETENTION.operationsDaysAfterClosed) } }, take: limit, select: { id: true } });
  if (rows.length === 0) return 0;
  const { count } = await db.opsAlert.deleteMany({ where: { id: { in: rows.map((row) => row.id) }, status: 'RESOLVED' } });
  return count;
}

/** Tareas del sistema que terminaron (hechas, fallidas o canceladas) hace más de 12 meses (§3.10). Una pendiente o en curso no se borra. */
export async function purgeFinishedJobs(db: Db, now: Date, limit: number): Promise<number> {
  const finished = { status: { in: ['DONE' as const, 'FAILED' as const, 'CANCELLED' as const] }, updatedAt: { lt: daysBefore(now, RETENTION.operationsDaysAfterClosed) } };
  const rows = await db.job.findMany({ where: finished, take: limit, select: { id: true } });
  if (rows.length === 0) return 0;
  const { count } = await db.job.deleteMany({ where: { id: { in: rows.map((row) => row.id) }, ...finished } });
  return count;
}

/** Solicitudes de derechos cerradas hace más de 3 años (§3.3): ya no hace falta poder demostrar que se atendieron (LOPDGDD, art. 72). */
export async function purgeClosedPrivacyRequests(db: Db, now: Date, limit: number): Promise<number> {
  const closed = { status: { in: ['COMPLETED' as const, 'REJECTED' as const] }, completedAt: { lt: daysBefore(now, RETENTION.privacyRequestDaysAfterClosed) } };
  const rows = await db.privacyRequest.findMany({ where: closed, take: limit, select: { id: true } });
  if (rows.length === 0) return 0;
  const { count } = await db.privacyRequest.deleteMany({ where: { id: { in: rows.map((row) => row.id) }, ...closed } });
  return count;
}

/** Descripción de las ideas terminadas hace más de un año (§3.4): texto libre de la familia. El título, la categoría y las firmas se quedan (historial del buzón). */
export async function emptyOldIdeaDescriptions(db: Db, now: Date, limit: number): Promise<number> {
  const rows = await db.idea.findMany({ where: { expiresAt: { lt: daysBefore(now, RETENTION.ideaDescriptionDaysAfterIdea) }, NOT: { description: '' } }, take: limit, select: { id: true } });
  if (rows.length === 0) return 0;
  const { count } = await db.idea.updateMany({ where: { id: { in: rows.map((row) => row.id) } }, data: { description: '' } });
  return count;
}

/** Nada de lo que se crea con un alta sin verificar ha llegado a usarse: ni dinero, ni firmas, ni sesiones. */
const UNUSED_ACCOUNT = {
  emailVerified: false,
  isSuperadmin: false,
  gdprAnonymizedAt: null,
  sessions: { none: {} },
  contributions: { none: {} },
  privacyRequests: { none: {} },
  walletSubscriptions: { none: {} },
  paymentMethodTokens: { none: {} },
  walletTransactions: { none: {} },
  escrowLedgerEntries: { none: {} },
  doubleCheckSignatures: { none: {} },
  doubleCheckChallenges: { none: {} },
  activityFundPayouts: { none: {} },
  supportTickets: { none: {} }
} satisfies Prisma.UserWhereInput;

/** Entidad recién dada de alta que nunca se usó: solo su alta, sin campañas, ideas, comercios, documentos, dinero ni más personas que quien la creó. */
const UNUSED_ORGANIZATION = {
  initiatives: { none: {} },
  ideas: { none: {} },
  sponsors: { none: {} },
  kybDocuments: { none: {} },
  files: { none: {} },
  contributions: { none: {} },
  ledgerJournals: { none: {} },
  payouts: { none: {} },
  invoices: { none: {} },
  supportTickets: { none: {} },
  signerHandovers: { none: {} },
  categories: { none: {} },
  doubleCheckSignatures: { none: {} },
  doubleCheckChallenges: { none: {} },
  walletSubscriptions: { none: {} },
  activityFundDeposits: { none: {} },
  activityFundPayouts: { none: {} },
  opsAlerts: { none: {} },
  partialRefunds: { none: {} },
  sponsorAllocations: { none: {} },
  walletTransactions: { none: {} },
  escrowLedgerEntries: { none: {} }
} satisfies Prisma.OrganizationWhereInput;

const INVITE_PREFIX = 'korum-invite:';

/**
 * Borra un alta que nunca verificó su email, si nadie la llegó a usar: la cuenta (con o sin contraseña: también la que solo creó una invitación), las entidades que
 * creó y nadie usó, su aceptación de los textos, las invitaciones y la cuenta de la persona cofirmante que esas invitaciones crearon, si tampoco se usó. Se comprueba
 * todo dentro de la transacción de quien llama; devuelve `false` (sin tocar nada) si algo la usa. Lo usan la purga de los 7 días y el enlace «No he sido yo», que
 * libera así el email anterior de una cuenta si alguien lo ocupó con un alta sin verificar (auditoría de seguridad del 5.10b).
 */
export async function deleteUnverifiedSignup(tx: Db, id: string, options: { cancelPending?: boolean; now?: Date } = {}): Promise<boolean> {
  const user = await tx.user.findFirst({ where: { id, ...UNUSED_ACCOUNT }, select: { email: true, canonicalEmail: true, memberships: { select: { organizationId: true, role: true } } } });
  if (!user || user.memberships.some((membership) => membership.role !== 'DIRECTOR')) return false;
  const openHandovers = { incomingUserId: id, status: { in: ['AWAITING_CONSENT' as const, 'INVITED' as const] } };
  // En la purga de los 7 días, un relevo abierto hacia esta cuenta la está usando.
  if (!options.cancelPending && (await tx.signerHandover.count({ where: openHandovers })) > 0) return false;
  const organizationIds = user.memberships.map((membership) => membership.organizationId);
  const unused = await tx.organization.count({ where: { id: { in: organizationIds }, ...UNUSED_ORGANIZATION, members: { every: { userId: id } } } });
  if (unused !== organizationIds.length) return false;
  if (options.cancelPending) {
    // «No he sido yo»: quien controla ese email nunca aceptó nada de lo que cuelga de esta cuenta; lo crearon terceros (auditoría de seguridad del 5.10b). Solo cuando la
    // cuenta se va a borrar de verdad: si algo la usa, no se toca nada.
    const handovers = await tx.signerHandover.findMany({ where: openHandovers, select: { id: true, organizationId: true } });
    for (const handover of handovers) {
      const { count } = await tx.signerHandover.updateMany({ where: { id: handover.id, status: { in: ['AWAITING_CONSENT', 'INVITED'] } }, data: { status: 'CANCELLED', closedAt: options.now ?? new Date() } });
      if (count > 0) await writeAudit(tx, { actorType: 'SYSTEM', organizationId: handover.organizationId, action: 'signer.handover_cancelled', targetType: 'SignerHandover', targetId: handover.id, metadata: { reason: 'EMAIL_RECOVERED' } });
    }
  }
  const invitedUserIds = new Set<string>();
  for (const organizationId of organizationIds) {
    const invitations = await tx.verification.findMany({ where: { identifier: { startsWith: INVITE_PREFIX, endsWith: `:${organizationId}` } }, select: { identifier: true } });
    for (const { identifier } of invitations) invitedUserIds.add(identifier.slice(INVITE_PREFIX.length, identifier.length - organizationId.length - 1));
    await tx.verification.deleteMany({ where: { identifier: { startsWith: INVITE_PREFIX, endsWith: `:${organizationId}` } } });
    // El email de invitación que aún no hubiera salido no sale ya: la entidad deja de existir.
    await tx.outboxMessage.updateMany({ where: { organizationId, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'CANCELLED' } });
  }
  await tx.legalAcceptance.deleteMany({ where: { OR: [{ userId: id }, ...(organizationIds.length > 0 ? [{ organizationId: { in: organizationIds } }] : [])] } });
  await tx.organizationMember.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await tx.organization.deleteMany({ where: { id: { in: organizationIds } } });
  // Sus propias invitaciones pendientes (si es una cuenta que solo creó una invitación) y sus códigos de acceso.
  await tx.verification.deleteMany({ where: { identifier: { startsWith: `${INVITE_PREFIX}${id}:` } } });
  await tx.verification.deleteMany({ where: pendingAccessCodesWhere([user.email, user.canonicalEmail]) });
  const { count } = await tx.user.deleteMany({ where: { id, ...UNUSED_ACCOUNT } });
  if (count === 0) return false;
  // La cuenta de la persona cofirmante que creó la invitación, si no tiene nada más (ni contraseña, ni otra invitación abierta).
  for (const invitedId of invitedUserIds) {
    if ((await tx.verification.count({ where: { identifier: { startsWith: `${INVITE_PREFIX}${invitedId}:` } } })) > 0) continue;
    await tx.user.deleteMany({ where: { id: invitedId, ...UNUSED_ACCOUNT, accounts: { none: {} }, memberships: { none: {} }, consentRecords: { none: {} }, legalAcceptances: { none: {} } } });
  }
  await writeAudit(tx, { actorType: 'SYSTEM', action: 'privacy.unverified_signup_deleted', targetType: 'Signup', targetId: '*', metadata: { organizations: organizationIds.length } });
  return true;
}

/**
 * Altas que nunca verificaron su email (§3.3), 7 días después: la cuenta (con su contraseña) y, si se creó con ella una entidad que nadie llegó a usar, la entidad, su
 * aceptación de las condiciones y del contrato de encargo (§3.9), la invitación a la persona cofirmante y la cuenta que esa invitación creó, si tampoco se usó. Cada
 * alta se borra en su transacción y se vuelve a comprobar dentro; si algo la sigue usando (una restricción de la base), se deja. Queda en la auditoría sin datos de nadie.
 */
export async function purgeUnverifiedSignups(db: Db, now: Date, limit: number): Promise<number> {
  const createdBefore = daysBefore(now, RETENTION.unverifiedSignupDays);
  const candidates = await db.user.findMany({
    where: { ...UNUSED_ACCOUNT, createdAt: { lt: createdBefore }, accounts: { some: {} }, memberships: { every: { role: 'DIRECTOR', organization: { ...UNUSED_ORGANIZATION, createdAt: { lt: createdBefore } } } } },
    orderBy: { id: 'asc' },
    take: limit,
    select: { id: true }
  });
  let deleted = 0;
  for (const { id } of candidates) {
    try {
      if (await inTransaction(db, (tx) => deleteUnverifiedSignup(tx, id))) deleted += 1;
    } catch {
      // Algo la sigue usando (una restricción de la base): no es un alta vacía y se queda.
    }
  }
  return deleted;
}
