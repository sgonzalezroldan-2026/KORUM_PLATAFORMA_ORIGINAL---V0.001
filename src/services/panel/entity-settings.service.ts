import { enterDoubleCheck } from '@/core/ideas/idea-quorum';
import { entitySettingsSchema, settingsToColumns } from '@/core/panel/entity-settings-rules';
import { inTransaction } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { recordAudit, type SessionActor } from '@/repositories/tenant-guard';
import { requireSigner } from './kyb.service';

/**
 * Ajustes generales de la entidad (Sprint 4.2c, «Valores de donación por defecto, firmas y patrocinios» del prototipo, más teléfono, idioma
 * del contenido e indexación). Los guardan las dos personas firmantes con el segundo factor; queda el antes y el después en `AuditLog`, en la
 * misma transacción. Lo que cambia y a qué afecta:
 *
 * - **Botones de donación y niveles de patrocinio:** solo a lo que se pague desde ahora (cada aportación y cada comercio guardan su importe).
 * - **Firmas mínimas:** si bajan, las ideas que ya recogen firmas y llegan al nuevo mínimo pasan a la doble firma ahora mismo, con su aviso a
 *   quienes firman (si no, esperarían a una firma más que quizá no llegue). Si suben, no se deshace nada: una idea que ya pasó, pasó.
 * - **Días para firmar una idea:** a las ideas que se aprueben desde ahora (las publicadas conservan su plazo).
 */

export class EntitySettingsError extends Error {
  constructor(readonly fields: string[]) {
    super(`Ajustes de la entidad no válidos: ${fields.join(', ')}.`);
    this.name = 'EntitySettingsError';
  }
}

export interface SaveEntitySettingsResult {
  /** Ideas que han pasado a la doble firma al bajar el mínimo de firmas (para enviar ya su aviso). */
  ideasToDoubleCheck: number[];
  /** Ha cambiado algo que se ve en el portal público (idioma o indexación): hay que regenerarlo. */
  portalChanged: boolean;
}

const BEFORE = { donationPresetsCents: true, defaultDonationIdx: true, minVotes: true, maxIdeaDays: true, sponsorTiersCents: true, phone: true, contentLocale: true, publicIndexing: true } as const;

export async function saveEntitySettings(db: KorumPrismaClient, actor: SessionActor, organizationId: string, raw: unknown, now: Date = new Date()): Promise<SaveEntitySettingsResult> {
  const signer = await requireSigner(db, actor, organizationId, 'organization.settings_update');
  const parsed = entitySettingsSchema.safeParse(raw);
  if (!parsed.success) throw new EntitySettingsError([...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'form')))]);
  const after = settingsToColumns(parsed.data);

  return inTransaction(db, async (tx) => {
    // Primero se bloquea la fila de la entidad: dos guardados a la vez se ordenan y el «antes» de cada auditoría es el real (auditoría del 4.2c).
    await tx.organization.updateMany({ where: { id: organizationId }, data: { updatedAt: now } });
    const before = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: BEFORE });
    await tx.organization.update({ where: { id: organizationId }, data: after });

    const ideasToDoubleCheck: number[] = [];
    if (after.minVotes < before.minVotes) {
      // Se bloquean antes las ideas que recogen firmas: una firma en curso (`signIdea` bloquea su idea) termina primero y aquí se ve ya contada.
      await tx.idea.updateMany({ where: { organizationId, phase: 'PUBLIC_VOTING' }, data: { votes: { increment: 0 } } });
      const ready = await tx.idea.findMany({
        where: { organizationId, phase: 'PUBLIC_VOTING', expiresAt: { gt: now }, verifiedVotes: { gte: Math.max(1, after.minVotes) } },
        select: { id: true, organizationId: true, alias: true, title: true },
        orderBy: { id: 'asc' }
      });
      for (const idea of ready) {
        await enterDoubleCheck(tx, idea, after.maxIdeaDays, now);
        ideasToDoubleCheck.push(idea.id);
      }
    }

    // El teléfono puede ser el de una persona: en la auditoría solo consta que cambió, no el número.
    const { phone: phoneBefore, ...restBefore } = before;
    const { phone: phoneAfter, ...restAfter } = after;
    await recordAudit(
      tx,
      signer,
      { action: 'organization.settings_updated', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { before: restBefore, after: restAfter, phoneChanged: phoneBefore !== phoneAfter, ideasToDoubleCheck } },
      { required: true }
    );
    return { ideasToDoubleCheck, portalChanged: before.contentLocale !== after.contentLocale || before.publicIndexing !== after.publicIndexing };
  });
}
