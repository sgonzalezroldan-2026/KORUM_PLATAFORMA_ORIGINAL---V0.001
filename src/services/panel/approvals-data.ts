import { displayIdeaAlias, ideaProgress } from '@/core/ideas/idea-rules';
import { SUSPICIOUS_REASONS } from '@/core/ideas/idea-moderation-rules';
import { evaluateDoubleCheck, requiredRolesFor, type SignerRole } from '@/core/security/double-check-evaluation';
import { ideaTargetDigest } from '@/core/security/signature-hash';
import { chatIsOpen } from '@/core/support/support-rules';
import type { KorumPrismaClient } from '@/lib/prisma';
import { listModerationIdeas, listOpenChallengesOf } from '@/repositories/idea-moderation.repository';
import { listIdeaCategoryOptions } from '@/repositories/ideas-public.repository';
import { listSigners } from '@/repositories/organization.repository';
import type { SessionActor } from '@/repositories/tenant-guard';

/**
 * Datos de la bandeja de aprobaciones (Sprint 4.2a) ya preparados para la vista, sin nada que no deba llegar al navegador: ni emails, ni huellas
 * de firma, ni identificadores de dispositivo. Para cada idea que espera la doble firma se comprueba **en el servidor** qué firmas siguen valiendo
 * (huella, cargo vigente, personas distintas), igual que al firmar: el panel no se fía de que exista una fila.
 */

export type ModerationPhase = 'PHASE0_MOD' | 'PUBLIC_VOTING' | 'DOUBLE_CHECK' | 'CONVERTED' | 'REJECTED';

export interface DoubleCheckSlot {
  role: SignerRole;
  /** Cargo de quien ocupa hoy ese puesto (`Presidencia del AMPA`…), para no enseñar una etiqueta genérica. `null` si no lo escribió. */
  holderLabel: string | null;
  /** Cargo y nombre de quien firmó, si su firma sigue valiendo. */
  signedBy: { name: string; roleLabel: string | null; signedAt: string } | null;
}

export interface ModerationIdeaView {
  id: number;
  alias: string;
  title: string;
  category: string;
  description: string;
  phase: ModerationPhase;
  verifiedVotes: number;
  suspiciousVotes: number;
  percent: number;
  daysRemaining: number;
  expiresAt: string;
  createdAt: string;
  chatOpen: boolean;
  signatures: Array<{ id: number; status: 'VERIFIED' | 'SUSPICIOUS'; reason: string; accountOrder: number; revalidated: boolean; createdAt: string }>;
  messages: Array<{ id: number; role: 'FAMILY' | 'ORGANIZATION' | 'SYSTEM'; label: string; body: string; createdAt: string }>;
  doubleCheck: { signed: number; slots: DoubleCheckSlot[]; mySlotOpen: boolean; myChallengeExpiresAt: string | null; revalidatedVotes: number } | null;
  initiative: { id: number; walletEscrowId: string } | null;
}

export interface ApprovalsData {
  minVotes: number;
  categories: string[];
  open: ModerationIdeaView[];
  closed: ModerationIdeaView[];
}

/** Lo que pide una acción va primero: revisar una propuesta nueva, después firmar, y por último las que siguen recogiendo firmas. */
const PHASE_ORDER: Record<string, number> = { PHASE0_MOD: 0, DOUBLE_CHECK: 1, PUBLIC_VOTING: 2 };

export async function loadApprovalsData(db: KorumPrismaClient, secret: string, actor: SessionActor, organizationId: string, now: Date = new Date()): Promise<ApprovalsData> {
  const { open, closed, minVotes } = await listModerationIdeas(db, actor, organizationId);
  const [signers, categories, challenges] = await Promise.all([
    listSigners(db, actor, organizationId),
    listIdeaCategoryOptions(db, organizationId),
    actor.kind === 'user' ? listOpenChallengesOf(db, organizationId, actor.userId, now) : Promise.resolve([])
  ]);
  const myRoles = actor.kind === 'user' && !actor.isSuperadmin ? actor.memberships.filter((membership) => membership.organizationId === organizationId).map((membership) => membership.role) : [];
  const myRole = myRoles.length === 1 && (myRoles[0] === 'DIRECTOR' || myRoles[0] === 'COSIGNER') ? myRoles[0] : null;

  async function view(idea: (typeof open)[number]): Promise<ModerationIdeaView> {
    const progress = ideaProgress(idea, minVotes, now);
    let doubleCheck: ModerationIdeaView['doubleCheck'] = null;
    if (idea.phase === 'DOUBLE_CHECK') {
      const context = { organizationId, targetType: 'IDEA_APPROVAL' as const, targetId: idea.id, targetDigest: ideaTargetDigest(secret, { organizationId, ...idea }) };
      const evaluation = await evaluateDoubleCheck(db, secret, context, idea.doubleCheckSignatures);
      const invalid = new Set(evaluation.invalid.map((entry) => entry.signatureId));
      const valid = idea.doubleCheckSignatures.filter((signature) => !invalid.has(signature.id) && evaluation.validRoles.includes(signature.signerRole as SignerRole));
      const requiredRoles = requiredRolesFor(evaluation.mode);
      const slots = requiredRoles.map((role): DoubleCheckSlot => {
        const signature = valid.find((entry) => entry.signerRole === role);
        const signer = signature ? signers.find((entry) => entry.userId === signature.signerUserId && entry.role === role) : undefined;
        const holder = signers.find((entry) => entry.role === role && entry.status !== 'INVITED') ?? signers.find((entry) => entry.role === role);
        return { role, holderLabel: holder?.roleLabel?.trim() || null, signedBy: signature ? { name: signer?.name ?? '', roleLabel: signer?.roleLabel ?? null, signedAt: signature.signedAt.toISOString() } : null };
      });
      const iSigned = actor.kind === 'user' && valid.some((signature) => signature.signerUserId === actor.userId);
      const challenge = challenges.find((entry) => entry.ideaId === idea.id);
      doubleCheck = {
        signed: valid.length,
        slots,
        mySlotOpen: myRole !== null && requiredRoles.includes(myRole) && !iSigned && !evaluation.validRoles.includes(myRole),
        myChallengeExpiresAt: challenge ? challenge.expiresAt.toISOString() : null,
        revalidatedVotes: idea._count.signatures
      };
    }
    return {
      id: idea.id,
      alias: displayIdeaAlias(idea.alias),
      title: idea.title,
      category: idea.category,
      description: idea.description,
      phase: idea.phase as ModerationPhase,
      verifiedVotes: idea.verifiedVotes,
      suspiciousVotes: idea.suspiciousVotes,
      percent: progress.percent,
      daysRemaining: progress.daysRemaining,
      expiresAt: idea.expiresAt.toISOString(),
      createdAt: idea.createdAt.toISOString(),
      chatOpen: chatIsOpen(idea.phase),
      signatures: idea.signatures.map((signature) => ({
        id: signature.id,
        status: signature.status,
        reason: signature.reason,
        accountOrder: signature.accountOrder,
        revalidated: signature.status === 'VERIFIED' && SUSPICIOUS_REASONS.includes(signature.reason),
        createdAt: signature.createdAt.toISOString()
      })),
      messages: [...idea.messages].reverse().map((message) => ({ id: message.id, role: message.senderRole, label: message.senderLabel, body: message.body, createdAt: message.createdAt.toISOString() })),
      doubleCheck,
      initiative: idea.initiative
    };
  }

  const sorted = [...open].sort((a, b) => (PHASE_ORDER[a.phase] ?? 9) - (PHASE_ORDER[b.phase] ?? 9) || a.id - b.id);
  return { minVotes, categories: categories.map((category) => category.name), open: await Promise.all(sorted.map(view)), closed: await Promise.all(closed.map(view)) };
}
