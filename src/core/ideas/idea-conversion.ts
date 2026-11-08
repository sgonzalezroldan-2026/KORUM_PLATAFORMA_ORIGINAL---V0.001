import { academicYearFor } from '@/core/finance/academic-year';
import { newWalletId } from '@/core/finance/wallet-id';
import type { Db } from '@/lib/db';

/**
 * Una idea que completa su doble firma (`CONVERTED`) crea su iniciativa en `BUDGETING` **en la misma transacción** (PRD §4.2, heredado del
 * Sprint 2.2). La iniciativa nace con el título, la categoría y la descripción que se firmaron, meta 0 y un cierre provisional (hoy + duración
 * máxima de campaña): el presupuesto, el curso y la fecha real los pone el Estudio (Sprint 4.3) antes de publicar. No es pública mientras esté
 * en presupuestación. `Initiative.sourceIdeaId` es único: repetir la conversión devuelve la iniciativa que ya existe.
 */

const DAY_MS = 86_400_000;
const WALLET_ATTEMPTS = 5;

/** Trimestre natural de una fecha (`2027-Q1`), como el de las iniciativas de la semilla. */
export function quarterOf(date: Date): string {
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

export interface ConvertedInitiative {
  initiativeId: number;
  walletEscrowId: string;
  created: boolean;
}

export async function createInitiativeFromIdea(tx: Db, ideaId: number, now: Date): Promise<ConvertedInitiative> {
  const existing = await tx.initiative.findUnique({ where: { sourceIdeaId: ideaId }, select: { id: true, walletEscrowId: true } });
  if (existing) return { initiativeId: existing.id, walletEscrowId: existing.walletEscrowId, created: false };

  const idea = await tx.idea.findUniqueOrThrow({ where: { id: ideaId }, select: { organizationId: true, title: true, category: true, description: true, phase: true } });
  if (idea.phase !== 'CONVERTED') throw new Error(`La idea ${ideaId} no está convertida (${idea.phase}).`);
  const { maxCampaignDays } = await tx.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' }, select: { maxCampaignDays: true } });
  const closesAt = new Date(now.getTime() + maxCampaignDays * DAY_MS);

  // Seis caracteres al azar: una colisión es casi imposible, pero dentro de una transacción un `P2002` la abortaría entera, así que se comprueba antes.
  let walletEscrowId = newWalletId();
  for (let attempt = 1; attempt < WALLET_ATTEMPTS && (await tx.initiative.findUnique({ where: { walletEscrowId }, select: { id: true } })); attempt += 1) {
    walletEscrowId = newWalletId();
  }

  const initiative = await tx.initiative.create({
    data: {
      walletEscrowId,
      format: 'BUDGET',
      organizationId: idea.organizationId,
      academicYear: academicYearFor(now),
      title: idea.title,
      category: idea.category,
      stage: '',
      status: 'BUDGETING',
      stepIndex: 3,
      closesAt,
      quarter: quarterOf(closesAt),
      goalCents: 0,
      description: idea.description,
      sourceIdeaId: ideaId,
      createdAt: now
    },
    select: { id: true, walletEscrowId: true }
  });
  return { initiativeId: initiative.id, walletEscrowId: initiative.walletEscrowId, created: true };
}
