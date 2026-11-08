import { SUSPICIOUS_REASONS } from '@/core/ideas/idea-moderation-rules';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { Prisma } from '@/generated/prisma/client';
import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeTenant, type SessionActor } from './tenant-guard';

/**
 * Lecturas de la bandeja de aprobaciones del panel (Sprint 4.2a). Autoriza primero (`DIRECTOR` o `COSIGNER` de **esa** entidad; el Super-Admin
 * entra con registro) y elige cada campo: ni el email de quien propone (`authorCanonicalEmail`) ni el de quien firma, ni el dispositivo, ni la
 * red. De cada firma se ve solo su estado, su motivo y su orden en el dispositivo.
 */

export const OPEN_PHASES = ['PHASE0_MOD', 'PUBLIC_VOTING', 'DOUBLE_CHECK'] as const;
/** Ideas cerradas que siguen a la vista (las últimas convertidas o desestimadas), para seguir su rastro sin una lista infinita. */
export const CLOSED_IDEAS_SHOWN = 10;
/** Firmas que se listan por idea: primero las sospechosas, que son las que hay que revisar; el total sale de los contadores de la idea. */
export const SIGNATURES_SHOWN = 100;
export const MESSAGES_SHOWN = 200;

const IDEA_VIEW = {
  id: true,
  alias: true,
  title: true,
  category: true,
  description: true,
  phase: true,
  votes: true,
  verifiedVotes: true,
  suspiciousVotes: true,
  expiresAt: true,
  createdAt: true,
  signatures: { orderBy: [{ status: 'desc' }, { id: 'desc' }], take: SIGNATURES_SHOWN, select: { id: true, status: true, reason: true, accountOrder: true, createdAt: true } },
  messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: MESSAGES_SHOWN, select: { id: true, senderRole: true, senderLabel: true, body: true, createdAt: true } },
  doubleCheckSignatures: { select: { id: true, organizationId: true, targetType: true, signerUserId: true, signerRole: true, signatureHash: true, otpVerifiedAt: true, signedAt: true } },
  initiative: { select: { id: true, walletEscrowId: true } },
  /** Firmas que cuentan porque la entidad las dio por buenas: quien firma la doble firma debe saberlo. */
  _count: { select: { signatures: { where: { status: 'VERIFIED', reason: { in: [...SUSPICIOUS_REASONS] } } } } }
} satisfies Prisma.IdeaSelect;

export async function listModerationIdeas(db: KorumPrismaClient, actor: SessionActor, organizationId: string) {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'idea.moderation_list', targetType: 'Organization' });
  const [open, closed, organization] = await Promise.all([
    db.idea.findMany({ where: { organizationId, phase: { in: [...OPEN_PHASES] } }, orderBy: [{ phase: 'desc' }, { id: 'asc' }], select: IDEA_VIEW }),
    db.idea.findMany({ where: { organizationId, phase: { in: ['CONVERTED', 'REJECTED'] } }, orderBy: { id: 'desc' }, take: CLOSED_IDEAS_SHOWN, select: IDEA_VIEW }),
    db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { minVotes: true } })
  ]);
  return { open, closed, minVotes: organization.minVotes };
}

/** Desafíos de doble firma aún abiertos de esta persona en la entidad: el panel dice «te hemos enviado el enlace» y hasta cuándo vale. */
export function listOpenChallengesOf(db: KorumPrismaClient, organizationId: string, userId: string, now: Date) {
  return db.doubleCheckChallenge.findMany({
    where: { organizationId, signerUserId: userId, targetType: 'IDEA_APPROVAL', consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
    select: { ideaId: true, expiresAt: true }
  });
}
