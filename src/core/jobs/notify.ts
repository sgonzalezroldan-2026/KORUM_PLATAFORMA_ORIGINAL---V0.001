import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { Prisma } from '@/generated/prisma/client';
import type { Db } from '@/lib/db';

/**
 * Avisos de las tareas programadas a quienes firman en una entidad (`DIRECTOR` y `COSIGNER`). Se escriben en la bandeja de salida
 * (`OutboxMessage`) dentro de la transacción del cambio que los provoca; el envío es del Sprint 2.6. La clave de idempotencia lleva
 * el motivo y a la persona, así que repetir la tarea no duplica el aviso. Las plantillas (`templateKey`) las define el catálogo de
 * EXPERIENCIA_DE_PRODUCTO §4; aquí solo se fijan sus nombres.
 */
export async function notifySigners(db: Db, organizationId: string, templateKey: string, subjectKey: string, payload: Prisma.InputJsonObject): Promise<number> {
  const signers = await db.organizationMember.findMany({
    where: { organizationId, role: { in: [...SIGNER_ROLES] }, user: { gdprAnonymizedAt: null, isSuperadmin: false } },
    select: { userId: true, user: { select: { email: true, locale: true } } }
  });
  const data = signers.map((signer) => ({
    idempotencyKey: `${templateKey}:${subjectKey}:${signer.userId}`,
    templateKey,
    locale: signer.user.locale,
    toAddress: signer.user.email,
    userId: signer.userId,
    organizationId,
    payloadJson: payload
  }));
  if (data.length === 0) return 0;
  const { count } = await db.outboxMessage.createMany({ data, skipDuplicates: true });
  return count;
}
