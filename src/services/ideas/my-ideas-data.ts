import { displayIdeaAlias, ideaProgress } from '@/core/ideas/idea-rules';
import { canonicalEmailOf, IdeaSignatureRejectedError } from '@/core/security/device-quorum.service';
import { chatBlockReason, type ChatBlock } from '@/core/support/support-rules';
import type { Db } from '@/lib/db';
import { countIdeasOf, listProposalsOf, listSignedIdeasOf } from '@/repositories/idea-account.repository';

/**
 * Lo que enseña *Mi cuenta* del buzón de ideas (Sprint 3.9): «Mis propuestas y mensajes con el centro» y «Mis firmas». Todo serializable, sin el
 * correo de nadie, sin los motivos de la auditoría y sin decir si una firma propia está en revisión (no se avisa a quien intenta un fraude).
 */

export interface MyIdeaView {
  id: number;
  alias: string;
  title: string;
  category: string;
  phase: 'PHASE0_MOD' | 'PUBLIC_VOTING' | 'DOUBLE_CHECK' | 'CONVERTED' | 'REJECTED';
  organizationName: string;
  organizationSlug: string;
  verifiedVotes: number;
  needed: number;
  percent: number;
  quorumReached: boolean;
  daysRemaining: number;
}

export interface ChatMessageView {
  id: number;
  role: 'FAMILY' | 'ORGANIZATION' | 'SYSTEM';
  label: string;
  body: string;
  createdAt: string;
}

export interface MyProposalView extends MyIdeaView {
  messages: ChatMessageView[];
  /** Por qué no puede escribir ahora (`null` si puede). */
  block: ChatBlock | null;
}

export interface MyIdeasData {
  proposals: MyProposalView[];
  signed: Array<MyIdeaView & { signedAt: string }>;
}

type IdeaSummaryRow = Awaited<ReturnType<typeof listProposalsOf>>[number];

function summarize(row: Omit<IdeaSummaryRow, 'messages'>, now: Date): MyIdeaView {
  const needed = Math.max(1, row.organization.minVotes);
  const progress = ideaProgress(row, needed, now);
  return {
    id: row.id,
    alias: displayIdeaAlias(row.alias),
    title: row.title,
    category: row.category,
    phase: row.phase,
    organizationName: row.organization.name,
    organizationSlug: row.organization.slug,
    verifiedVotes: row.verifiedVotes,
    needed,
    percent: progress.percent,
    quorumReached: progress.quorumReached,
    daysRemaining: progress.daysRemaining
  };
}

export async function loadMyIdeas(db: Db, userId: string, now: Date = new Date()): Promise<MyIdeasData> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, emailVerified: true, gdprAnonymizedAt: true } });
  let canonicalEmail: string;
  try {
    canonicalEmail = canonicalEmailOf(user);
  } catch (error) {
    // Una cuenta sin el email verificado, anonimizada o con un email desechable no ha propuesto ni firmado nada por ese medio.
    if (error instanceof IdeaSignatureRejectedError) return { proposals: [], signed: [] };
    throw error;
  }
  const [proposals, signed] = await Promise.all([
    listProposalsOf(db, canonicalEmail),
    // Solo por la cuenta y el email actual: la marca anónima de una supresión anterior sirve para impedir firmar dos veces, no para devolver a quien
    // vuelve el listado de lo que firmó antes (el texto legal dice que la cuenta nueva empieza vacía).
    listSignedIdeasOf(db, { userId, canonicalEmails: [canonicalEmail] })
  ]);
  return {
    proposals: proposals.map((row) => ({
      ...summarize(row, now),
      messages: [...row.messages].reverse().map((message) => ({ id: message.id, role: message.senderRole, label: message.senderLabel, body: message.body, createdAt: message.createdAt.toISOString() })),
      block: chatBlockReason(row.phase, [...row.messages].reverse())
    })),
    signed: signed.map((row) => ({ ...summarize(row, now), signedAt: row.signedAt.toISOString() }))
  };
}

/** Resumen para *Mi cuenta*: cuántas propuestas y firmas tiene la persona. */
export async function countMyIdeas(db: Db, userId: string): Promise<{ proposals: number; signed: number; organizationSlug: string | null }> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, emailVerified: true, gdprAnonymizedAt: true } });
  try {
    const canonicalEmail = canonicalEmailOf(user);
    return await countIdeasOf(db, { userId, canonicalEmails: [canonicalEmail] });
  } catch (error) {
    if (error instanceof IdeaSignatureRejectedError) return { proposals: 0, signed: 0, organizationSlug: null };
    throw error;
  }
}
