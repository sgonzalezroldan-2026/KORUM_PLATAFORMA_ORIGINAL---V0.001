'use server';

import { z } from 'zod';
import { getSessionActor } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { resolveAuditPerson } from '@/repositories/audit.repository';
import { TenantAccessError } from '@/repositories/tenant-guard';

/**
 * Buscar por persona en el visor de la auditoría (Sprint 5.8a). La auditoría guarda el identificador de cada cuenta, no su email: esta acción traduce el
 * email que escribe el Super-Admin a ese identificador, y la página filtra por él. Así el email no viaja en la dirección de la página (historial del
 * navegador, registros del servidor) ni se anota en ninguna parte. Solo el Super-Admin con el segundo factor de su sesión; cualquier otra cuenta recibe
 * `FORBIDDEN`, queda en la auditoría y no averigua si el email existe.
 */

const input = z.object({ email: z.string().trim().min(3).max(320).email() });

export type FindAuditPersonResult = { status: 'FOUND'; userId: string } | { status: 'NOT_FOUND' } | { status: 'ERROR'; reason: 'FORBIDDEN' | 'INVALID' };

export async function findAuditPersonAction(payload: unknown): Promise<FindAuditPersonResult> {
  try {
    const actor = await getSessionActor();
    // Primero quién lo pide y después qué pide: a una cuenta sin permiso no se le dice ni que el dato estaba mal escrito.
    const parsed = input.safeParse(payload);
    const userId = await resolveAuditPerson(getPrisma(), actor, parsed.success ? parsed.data.email : '');
    if (!parsed.success) return { status: 'ERROR', reason: 'INVALID' };
    return userId ? { status: 'FOUND', userId } : { status: 'NOT_FOUND' };
  } catch (error) {
    if (error instanceof TenantAccessError) return { status: 'ERROR', reason: 'FORBIDDEN' };
    throw error;
  }
}
