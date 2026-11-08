'use server';

import { getAuthSession } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { sendFamilyIdeaMessage, type SendChatOutcome } from '@/services/ideas/idea-chat.service';

/**
 * Escribir al centro desde *Mi cuenta* (Sprint 3.9). Quién escribe sale de la sesión: la acción no acepta ningún identificador de persona, y la
 * idea solo se admite si es de esa persona (una ajena responde igual que una inexistente). La lógica vive en `idea-chat.service.ts`.
 */
export async function sendIdeaMessageAction(payload: unknown): Promise<SendChatOutcome | { status: 'LOGIN_REQUIRED' }> {
  const session = await getAuthSession();
  if (!session) return { status: 'LOGIN_REQUIRED' };
  return sendFamilyIdeaMessage(getPrisma(), { userId: session.userId, payload });
}
