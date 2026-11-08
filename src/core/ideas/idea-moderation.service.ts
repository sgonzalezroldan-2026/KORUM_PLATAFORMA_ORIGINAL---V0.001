import type { z } from 'zod';
import { revokeOpenChallenges } from '@/core/security/double-check-email';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { chatIsOpen, chatMessageSchema } from '@/core/support/support-rules';
import { inTransaction, type Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { IDEA_CHAT_RULE } from '@/lib/rate-limit-rules';
import { listIdeaCategoryOptions } from '@/repositories/ideas-public.repository';
import { requireOwnedResource } from '@/repositories/ownership';
import { authorizeTenant, recordAudit, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { approveIdeaSchema, rejectIdeaSchema, revalidateSignatureSchema } from './idea-moderation-rules';
import { displayIdeaAlias } from './idea-rules';
import { enterDoubleCheck, meetsQuorum } from './idea-quorum';

/**
 * Moderación del buzón de ideas desde el panel (Sprint 4.2a, `sch-sub-moderation`). Solo quienes firman por **esa** entidad (`DIRECTOR`,
 * `COSIGNER`) y con el segundo factor en la sesión; el Super-Admin no modera en nombre de una entidad. La idea se pide siempre junto a su entidad:
 * una de otra responde igual que una inexistente y queda en la auditoría. Nada de esto lee ni devuelve el email de quien propone o firma.
 *
 * - **Aprobar** (`PHASE0_MOD → PUBLIC_VOTING`): la entidad puede corregir título, categoría y descripción; el plazo de firmas empieza ese día y,
 *   si la firma de quien propone ya alcanza el mínimo, la idea pasa directamente a la doble firma (heredado del Sprint 3.6).
 * - **Desestimar** (`→ REJECTED`): el motivo queda en el chat, firmado con el cargo, y la familia recibe un aviso sin el texto. Los enlaces de
 *   doble firma que estuvieran abiertos se anulan.
 * - **Responder en el chat** y **revalidar** una firma sospechosa (la entidad sabe que seis familias firmaron desde el wifi del centro).
 */

export type ModerationRejection = 'INVALID_INPUT' | 'NOT_FOUND' | 'WRONG_PHASE' | 'INVALID_CATEGORY' | 'CHAT_CLOSED' | 'RATE_LIMITED' | 'NOT_SUSPICIOUS';

export class IdeaModerationError extends Error {
  readonly reason: ModerationRejection;

  constructor(reason: ModerationRejection) {
    super(`No se puede moderar la idea: ${reason}.`);
    this.name = 'IdeaModerationError';
    this.reason = reason;
  }
}

type Action = 'idea.approve' | 'idea.reject' | 'idea.reply' | 'idea.revalidate_signature';

function parse<T extends z.ZodType>(schema: T, payload: unknown): z.infer<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new IdeaModerationError('INVALID_INPUT');
  return parsed.data;
}

/**
 * Segundo factor de **esta** sesión, cargo en esta entidad y propiedad de la idea, antes de abrir ninguna transacción. Las acciones ya exigen
 * el segundo factor; se repite aquí para que una futura ruta o tarea que llame al servicio no pueda olvidarlo (defensa en profundidad).
 */
async function authorizeIdea(db: KorumPrismaClient, actor: SessionActor, organizationId: string, id: number, action: Action): Promise<string> {
  if (actor.kind !== 'user' || actor.secondFactor !== true) {
    await recordAudit(db, actor, { action: 'tenant.access_denied', organizationId, targetType: 'Idea', targetId: String(id), metadata: { reason: 'SECOND_FACTOR_REQUIRED', attempted: action } });
    throw new TenantAccessError(actor.kind === 'user' ? 'ROLE_NOT_ALLOWED' : 'ANONYMOUS');
  }
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action, targetType: 'Idea', targetId: id, allowSuperadmin: false });
  const owner = await db.idea.findUnique({ where: { id }, select: { organizationId: true } });
  await requireOwnedResource(db, actor, { organizationId, resourceType: 'Idea', resourceId: id, resourceLabel: 'Idea', ownerOrganizationId: owner?.organizationId ?? null });
  return (actor as Extract<SessionActor, { kind: 'user' }>).userId;
}

/** Bloquea la idea (las decisiones sobre ella se ordenan) y devuelve lo que hace falta para decidir. */
const lockIdea = (tx: Db, id: number) =>
  tx.idea.update({
    where: { id },
    data: { votes: { increment: 0 } },
    select: { id: true, organizationId: true, alias: true, title: true, phase: true, expiresAt: true, verifiedVotes: true, suspiciousVotes: true, authorCanonicalEmail: true, organization: { select: { name: true, minVotes: true, maxIdeaDays: true } } }
  });

/** Firma de los mensajes de la entidad en el chat: el cargo de quien escribe (nunca su nombre ni su email) o, sin cargo, el nombre de la entidad. */
async function senderLabelOf(tx: Db, organizationId: string, userId: string, fallback: string): Promise<string> {
  const member = await tx.organizationMember.findFirst({ where: { organizationId, userId, role: { in: [...SIGNER_ROLES] } }, select: { roleLabel: true } });
  return (member?.roleLabel?.trim() || fallback).slice(0, 80);
}

/**
 * Aviso a quien propuso (`idea.centerReplied`), **sin el texto** del mensaje: lo lee en *Mi cuenta* con su sesión. Como mucho uno al día por
 * idea y tipo, para que una conversación no llene su bandeja. Si la cuenta se suprimió, no hay a quién avisar.
 */
async function notifyAuthor(tx: Db, idea: { id: number; organizationId: string; alias: string; authorCanonicalEmail: string }, kind: 'REPLY' | 'REJECTED' | 'APPROVED', now: Date, extra: { edited?: boolean } = {}): Promise<void> {
  const author = await tx.user.findFirst({ where: { canonicalEmail: idea.authorCanonicalEmail, gdprAnonymizedAt: null }, select: { id: true, email: true, locale: true } });
  if (!author) return;
  await tx.outboxMessage.createMany({
    data: [{ idempotencyKey: `idea.centerReplied:${idea.id}:${kind}:${now.toISOString().slice(0, 10)}`, templateKey: 'idea.centerReplied', locale: author.locale, toAddress: author.email, userId: author.id, organizationId: idea.organizationId, payloadJson: { ideaId: idea.id, alias: displayIdeaAlias(idea.alias), kind, ...extra } }],
    skipDuplicates: true
  });
}

export async function approveIdeaForVoting(db: KorumPrismaClient, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<{ phase: 'PUBLIC_VOTING' | 'DOUBLE_CHECK' }> {
  const input = parse(approveIdeaSchema, payload);
  const userId = await authorizeIdea(db, actor, organizationId, input.ideaId, 'idea.approve');
  return inTransaction(db, async (tx) => {
    const idea = await lockIdea(tx, input.ideaId);
    if (idea.phase !== 'PHASE0_MOD') throw new IdeaModerationError('WRONG_PHASE');
    if (!(await listIdeaCategoryOptions(tx, organizationId)).some((category) => category.name === input.category)) throw new IdeaModerationError('INVALID_CATEGORY');
    // El plazo de firmas empieza hoy: una idea que tardó en revisarse no llega al buzón ya caducada (heredado del Sprint 3.6).
    const expiresAt = new Date(now.getTime() + idea.organization.maxIdeaDays * 86_400_000);
    const current = await tx.idea.findUniqueOrThrow({ where: { id: idea.id }, select: { title: true, category: true, description: true } });
    const edited = current.title !== input.title || current.category !== input.category || current.description !== input.description;
    await tx.idea.update({ where: { id: idea.id }, data: { phase: 'PUBLIC_VOTING', title: input.title, category: input.category, description: input.description, expiresAt } });
    const quorum = meetsQuorum(idea.verifiedVotes, idea.organization.minVotes);
    if (quorum) await enterDoubleCheck(tx, { ...idea, title: input.title }, idea.organization.maxIdeaDays, now);
    // La familia sabe que su idea ya recoge firmas y, si la entidad corrigió el texto, que lo revise (auditoría del 4.2a, M1).
    await notifyAuthor(tx, idea, 'APPROVED', now, { edited });
    await tx.auditLog.create({ data: { actorType: 'USER', actorUserId: userId, organizationId, action: 'idea.approved', targetType: 'Idea', targetId: String(idea.id), metadataJson: { edited, quorumReached: quorum } } });
    return { phase: quorum ? 'DOUBLE_CHECK' : 'PUBLIC_VOTING' };
  });
}

export async function rejectIdea(db: KorumPrismaClient, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<void> {
  const input = parse(rejectIdeaSchema, payload);
  const userId = await authorizeIdea(db, actor, organizationId, input.ideaId, 'idea.reject');
  await inTransaction(db, async (tx) => {
    const idea = await lockIdea(tx, input.ideaId);
    if (!chatIsOpen(idea.phase)) throw new IdeaModerationError('WRONG_PHASE');
    await tx.idea.update({ where: { id: idea.id }, data: { phase: 'REJECTED' } });
    // El motivo queda en el chat, firmado con el cargo: es lo que la familia lee en *Mi cuenta*. Sin datos de la familia.
    await tx.ideaMessage.create({ data: { ideaId: idea.id, senderRole: 'ORGANIZATION', senderLabel: await senderLabelOf(tx, organizationId, userId, idea.organization.name), body: input.reason, createdAt: now } });
    const revoked = await revokeOpenChallenges(tx, { targetType: 'IDEA_APPROVAL', ideaId: idea.id }, now);
    await notifyAuthor(tx, idea, 'REJECTED', now);
    await tx.auditLog.create({ data: { actorType: 'USER', actorUserId: userId, organizationId, action: 'idea.rejected', targetType: 'Idea', targetId: String(idea.id), metadataJson: { fromPhase: idea.phase, revokedChallenges: revoked } } });
  });
}

export async function replyToIdea(db: KorumPrismaClient, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<{ messageId: number }> {
  const input = parse(chatMessageSchema, payload);
  const userId = await authorizeIdea(db, actor, organizationId, input.ideaId, 'idea.reply');
  // El mismo cupo que el chat de las familias: cada mensaje es una fila y, como mucho una vez al día, un email.
  if (!(await reserveAttempt(db, `${IDEA_CHAT_RULE.prefix}${userId}`, IDEA_CHAT_RULE, now))) throw new IdeaModerationError('RATE_LIMITED');
  return inTransaction(db, async (tx) => {
    const idea = await lockIdea(tx, input.ideaId);
    if (!chatIsOpen(idea.phase)) throw new IdeaModerationError('CHAT_CLOSED');
    const message = await tx.ideaMessage.create({ data: { ideaId: idea.id, senderRole: 'ORGANIZATION', senderLabel: await senderLabelOf(tx, organizationId, userId, idea.organization.name), body: input.body, createdAt: now }, select: { id: true } });
    await notifyAuthor(tx, idea, 'REPLY', now);
    await tx.auditLog.create({ data: { actorType: 'USER', actorUserId: userId, organizationId, action: 'idea.replied', targetType: 'Idea', targetId: String(idea.id), metadataJson: { messageId: message.id } } });
    return { messageId: message.id };
  });
}

/**
 * La entidad da por buena una firma sospechosa (p. ej. seis familias que firmaron desde el wifi del centro, o la tercera cuenta de un móvil que
 * es de la abuela). Pasa a contar para el quórum, y la idea a la doble firma si lo alcanza. La fila conserva su motivo original: así se sabe
 * después que fue una revalidación. El orden de la cuenta en el dispositivo no se toca: es de todas las entidades y no lo decide una sola.
 */
export async function revalidateSignature(db: KorumPrismaClient, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<{ quorumReached: boolean }> {
  const input = parse(revalidateSignatureSchema, payload);
  const userId = await authorizeIdea(db, actor, organizationId, input.ideaId, 'idea.revalidate_signature');
  return inTransaction(db, async (tx) => {
    const idea = await lockIdea(tx, input.ideaId);
    if (idea.phase !== 'PUBLIC_VOTING' && idea.phase !== 'DOUBLE_CHECK') throw new IdeaModerationError('WRONG_PHASE');
    // Una idea que no logró el apoyo a tiempo no se resucita revalidando firmas días después (auditoría del 4.2a, I2).
    if (idea.expiresAt <= now) throw new IdeaModerationError('WRONG_PHASE');
    const { count } = await tx.ideaSignatureAudit.updateMany({ where: { id: input.signatureId, ideaId: idea.id, status: 'SUSPICIOUS' }, data: { status: 'VERIFIED' } });
    if (count === 0) throw new IdeaModerationError('NOT_SUSPICIOUS');
    await tx.idea.update({ where: { id: idea.id }, data: { verifiedVotes: { increment: 1 }, suspiciousVotes: { decrement: 1 } } });
    const quorumReached = idea.phase === 'PUBLIC_VOTING' && meetsQuorum(idea.verifiedVotes + 1, idea.organization.minVotes);
    if (quorumReached) await enterDoubleCheck(tx, idea, idea.organization.maxIdeaDays, now);
    await tx.auditLog.create({ data: { actorType: 'USER', actorUserId: userId, organizationId, action: 'idea.signature_revalidated', targetType: 'Idea', targetId: String(idea.id), metadataJson: { signatureId: input.signatureId, quorumReached } } });
    return { quorumReached };
  });
}
