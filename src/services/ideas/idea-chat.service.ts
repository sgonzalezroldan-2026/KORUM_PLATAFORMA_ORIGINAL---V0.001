import { displayIdeaAlias } from '@/core/ideas/idea-rules';
import { canonicalEmailOf, IdeaSignatureRejectedError } from '@/core/security/device-quorum.service';
import { chatBlockReason, chatMessageSchema, type ChatBlock } from '@/core/support/support-rules';
import { inTransaction, type Db } from '@/lib/db';
import { reserveAttempt } from '@/lib/rate-limit';
import { IDEA_CHAT_RULE } from '@/lib/rate-limit-rules';
import { findOwnIdeaForChat, listChatRoles } from '@/repositories/idea-account.repository';
import { writeAudit } from '@/services/audit/audit.service';

/**
 * Chat anónimo entre quien propone una idea y el centro, lado de la familia (Sprint 3.9, QA-F06). Solo escribe la persona que propuso la idea
 * (su email canónico verificado, de la sesión: nunca un identificador del cliente) y el mensaje se firma siempre con el alias `#FAM-XXXX` que
 * puso el servidor, no con texto de la familia. Una idea ajena responde igual que una que no existe y deja rastro en la auditoría. Las respuestas
 * del centro (`ORGANIZATION`) las escribe el panel (Sprint 4.2).
 */

export type ChatRejection = 'INVALID_INPUT' | 'RATE_LIMITED' | 'NOT_FOUND' | 'ACCOUNT_NOT_ALLOWED' | ChatBlock;
export type SendChatOutcome = { status: 'SENT'; messageId: number } | { status: 'REJECTED'; reason: ChatRejection };

export async function sendFamilyIdeaMessage(db: Db, input: { userId: string; payload: unknown }, now: Date = new Date()): Promise<SendChatOutcome> {
  // Lo que no es un mensaje válido no gasta el cupo de nadie.
  const parsed = chatMessageSchema.safeParse(input.payload);
  if (!parsed.success) return { status: 'REJECTED', reason: 'INVALID_INPUT' };
  const key = `${IDEA_CHAT_RULE.prefix}${input.userId}`;
  if (!(await reserveAttempt(db, key, IDEA_CHAT_RULE, now))) return { status: 'REJECTED', reason: 'RATE_LIMITED' };

  const outcome = await inTransaction(db, async (tx): Promise<SendChatOutcome> => {
    // Bloquea a la persona: dos mensajes a la vez no pueden esquivar el tope de mensajes sin respuesta.
    const user = await tx.user.update({ where: { id: input.userId }, data: { updatedAt: now }, select: { email: true, emailVerified: true, gdprAnonymizedAt: true } });
    let canonicalEmail: string;
    try {
      canonicalEmail = canonicalEmailOf(user);
    } catch (error) {
      if (error instanceof IdeaSignatureRejectedError) return { status: 'REJECTED', reason: 'ACCOUNT_NOT_ALLOWED' };
      throw error;
    }
    const idea = await findOwnIdeaForChat(tx, parsed.data.ideaId, canonicalEmail);
    if (!idea) {
      await writeAudit(tx, { actorType: 'USER', actorUserId: input.userId, action: 'idea.chat_access_denied', targetType: 'Idea', targetId: String(parsed.data.ideaId) });
      return { status: 'REJECTED', reason: 'NOT_FOUND' };
    }
    // Y la idea: el recuento de mensajes y el alta del nuevo se hacen de uno en uno.
    await tx.idea.update({ where: { id: idea.id }, data: { votes: { increment: 0 } } });
    const block = chatBlockReason(idea.phase, await listChatRoles(tx, idea.id));
    if (block) return { status: 'REJECTED', reason: block };
    const message = await tx.ideaMessage.create({ data: { ideaId: idea.id, senderRole: 'FAMILY', senderLabel: displayIdeaAlias(idea.alias), body: parsed.data.body, createdAt: now }, select: { id: true } });
    return { status: 'SENT', messageId: message.id };
  });

  // Todo intento que llega a la base gasta cupo, también los rechazados (cada uno bloquea filas): la interfaz ya oculta el formulario cuando no se puede escribir.
  return outcome;
}
