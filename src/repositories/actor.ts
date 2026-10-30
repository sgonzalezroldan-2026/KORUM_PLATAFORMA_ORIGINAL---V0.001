import type { KorumPrismaClient } from '@/lib/prisma';
import type { RequestMeta, SessionActor } from './tenant-guard';

/**
 * Construye el actor de una persona registrada a partir de la base de datos. Es el punto de unión con la autenticación
 * (Sprint 3.2): Better Auth identifica a la persona (`userId`) y aquí se cargan SUS membresías y su condición de
 * Super-Admin. Nunca se aceptan membresías enviadas por el cliente.
 */
export async function loadUserActor(db: KorumPrismaClient, userId: string, requestMeta?: RequestMeta): Promise<SessionActor> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, isSuperadmin: true, gdprAnonymizedAt: true, memberships: { select: { organizationId: true, role: true, organization: { select: { archivedAt: true } } } } }
  });
  if (!user || user.gdprAnonymizedAt) return { kind: 'anonymous', requestMeta };
  return {
    kind: 'user',
    userId: user.id,
    isSuperadmin: user.isSuperadmin,
    // Una entidad archivada deja de dar acceso a sus miembros.
    memberships: user.memberships.filter((membership) => membership.organization.archivedAt === null).map(({ organizationId, role }) => ({ organizationId, role })),
    requestMeta
  };
}

export const ANONYMOUS: SessionActor = { kind: 'anonymous' };
