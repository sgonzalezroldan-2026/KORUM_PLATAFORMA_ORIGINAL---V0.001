import { notifySigners } from '@/core/jobs/notify';
import type { Db } from '@/lib/db';
import { displayIdeaAlias } from './idea-rules';

/**
 * Paso de una idea a `DOUBLE_CHECK` al alcanzar el quórum, sea por una firma (`signIdea`), al aprobarla la entidad (con `minVotes = 1` la firma
 * de quien propone ya basta, heredado del Sprint 3.6) o al revalidar una firma sospechosa. Dos cosas que antes faltaban:
 *
 * - **Plazo propio para firmar:** la doble firma vence con `expiresAt`. Si el quórum llega el último día de firmas, quienes firman por la entidad
 *   tendrían horas; desde aquí tienen otra vez `maxIdeaDays` completos.
 * - **Aviso a quienes firman** (`idea.quorumReached`, a `DIRECTOR` y `COSIGNER`), en la misma transacción: una idea no se queda esperando sin
 *   que nadie lo sepa. La clave del aviso lleva la idea: repetir el paso no lo duplica.
 */

const DAY_MS = 86_400_000;

/** `true` si las firmas verificadas alcanzan el mínimo de la entidad. Las sospechosas nunca cuentan. */
export const meetsQuorum = (verifiedVotes: number, minVotes: number): boolean => verifiedVotes >= Math.max(1, minVotes);

export async function enterDoubleCheck(tx: Db, idea: { id: number; organizationId: string; alias: string; title: string }, maxIdeaDays: number, now: Date): Promise<Date> {
  const expiresAt = new Date(now.getTime() + maxIdeaDays * DAY_MS);
  const { count } = await tx.idea.updateMany({ where: { id: idea.id, phase: { in: ['PHASE0_MOD', 'PUBLIC_VOTING'] } }, data: { phase: 'DOUBLE_CHECK', expiresAt } });
  if (count === 1) await notifySigners(tx, idea.organizationId, 'idea.quorumReached', `idea:${idea.id}`, { ideaId: idea.id, alias: displayIdeaAlias(idea.alias), ideaTitle: idea.title.slice(0, 200) });
  return expiresAt;
}
