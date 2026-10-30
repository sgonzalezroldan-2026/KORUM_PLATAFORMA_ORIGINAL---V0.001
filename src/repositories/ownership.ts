import type { KorumPrismaClient } from '@/lib/prisma';
import { recordCrossTenantAttempt, recordMissingResourceProbe, ResourceNotFoundError, type SessionActor } from './tenant-guard';

/**
 * Anti-enumeración de identificadores: un recurso (iniciativa, comercio, idea…) se pide siempre junto a su entidad. Si el
 * identificador es de OTRA entidad se responde exactamente igual que si no existiera (404, sin revelar que existe en otra)
 * y el intento queda en `AuditLog`: `tenant.resource_outside_tenant` si es de otra entidad y `tenant.resource_not_found`
 * si no existe, para que ambos casos hagan el mismo trabajo y se puedan detectar los sondeos. Solo se lee el identificador
 * del dueño, nunca el recurso. Se llama DESPUÉS de `authorizeTenant`, de modo que quien llega aquí ya es miembro de la entidad.
 */
export async function requireOwnedResource(
  db: KorumPrismaClient,
  actor: SessionActor,
  resource: { organizationId: string; resourceType: string; resourceId: number | string; resourceLabel: string; ownerOrganizationId: string | null }
): Promise<void> {
  if (resource.ownerOrganizationId === resource.organizationId) return;
  const probe = { organizationId: resource.organizationId, resourceType: resource.resourceType, resourceId: resource.resourceId };
  if (resource.ownerOrganizationId !== null) await recordCrossTenantAttempt(db, actor, { ...probe, ownerOrganizationId: resource.ownerOrganizationId });
  else await recordMissingResourceProbe(db, actor, probe);
  throw new ResourceNotFoundError(resource.resourceLabel);
}
