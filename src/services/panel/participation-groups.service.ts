import { groupIssues, participationGroupsSchema, toStoredGroups, type GroupIssue } from '@/core/panel/participation-groups-rules';
import { defaultGroupTemplate, orderedGroupClusters } from '@/core/public/course-challenge';
import { inTransaction } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { recordAudit, type SessionActor } from '@/repositories/tenant-guard';
import type { ParticipationGroupCluster } from '@/types/korum.types';
import { requireSigner } from './kyb.service';

/**
 * Grupos de participación de la entidad (Sprint 4.2e, heredado del 3.2). Los guardan las dos personas firmantes con el segundo factor; queda el antes
 * y el después en la auditoría, en la misma transacción. Afectan a lo que se vea y se pague **desde ahora** (el desplegable del checkout, el reto
 * por curso, el `?grupo=` de los enlaces); cada aportación ya hecha conserva el nombre de su grupo.
 */

export class ParticipationGroupsError extends Error {
  constructor(
    readonly fields: string[],
    readonly issues: GroupIssue[] = []
  ) {
    super(`Grupos de participación no válidos: ${[...fields, ...issues.map((issue) => issue.code)].join(', ')}.`);
    this.name = 'ParticipationGroupsError';
  }
}

export interface ParticipationGroupsData {
  blocks: ParticipationGroupCluster[];
  /** Plantilla oficial de su vertical, para volver a ella desde el formulario. */
  template: ParticipationGroupCluster[];
  customized: boolean;
}

/** Lo que enseña el formulario: los grupos actuales (los suyos o la plantilla) y la plantilla. Quien llama ya ha pasado la guardia de la página. */
export function participationGroupsView(vertical: string, stored: unknown): ParticipationGroupsData {
  const template = defaultGroupTemplate(vertical).map((cluster) => ({
    group: cluster.group,
    items: [...cluster.items]
  }));
  const blocks = orderedGroupClusters(vertical, stored).map((cluster) => ({
    group: cluster.group,
    items: [...cluster.items]
  }));
  return {
    blocks,
    template,
    customized: JSON.stringify(blocks) !== JSON.stringify(template)
  };
}

export async function saveParticipationGroups(db: KorumPrismaClient, actor: SessionActor, organizationId: string, raw: unknown, now: Date = new Date()): Promise<ParticipationGroupCluster[]> {
  const signer = await requireSigner(db, actor, organizationId, 'organization.groups_update');
  const parsed = participationGroupsSchema.safeParse(raw);
  if (!parsed.success) {
    // `blocks.2.items.0` → `blocks.2.items`: el formulario señala el nombre o la lista del bloque que hay que corregir.
    throw new ParticipationGroupsError([...new Set(parsed.error.issues.map((issue) => issue.path.slice(0, 3).join('.') || 'form'))]);
  }
  const blocks = toStoredGroups(parsed.data.blocks);
  const issues = groupIssues(blocks);
  if (issues.length > 0) throw new ParticipationGroupsError([], issues);

  return inTransaction(db, async (tx) => {
    await tx.organization.updateMany({
      where: { id: organizationId },
      data: { updatedAt: now }
    });
    const before = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { participationGroupsJson: true }
    });
    await tx.organization.update({
      where: { id: organizationId },
      data: {
        participationGroupsJson: blocks.map((block) => ({
          group: block.group,
          items: block.items
        }))
      }
    });
    await recordAudit(
      tx,
      signer,
      {
        action: 'organization.groups_updated',
        organizationId,
        targetType: 'Organization',
        targetId: organizationId,
        metadata: {
          before: before.participationGroupsJson ?? null,
          after: blocks.map((block) => ({
            group: block.group,
            items: block.items
          }))
        }
      },
      { required: true }
    );
    return blocks;
  });
}
