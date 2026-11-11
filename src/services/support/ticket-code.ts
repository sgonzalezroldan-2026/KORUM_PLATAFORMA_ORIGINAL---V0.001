import { generateTicketCode } from '@/core/support/support-rules';
import type { Db } from '@/lib/db';

const CODE_ATTEMPTS = 8;

/** Un código `TCK-XXXXXX` que no use ninguna consulta (se reintenta ante una colisión; `null` si no hay forma tras 8 intentos). Dentro de la transacción de la consulta. */
export async function allocateTicketCode(tx: Pick<Db, 'supportTicket'>): Promise<string | null> {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const candidate = generateTicketCode();
    if (!(await tx.supportTicket.findUnique({ where: { ticketCode: candidate }, select: { id: true } }))) return candidate;
  }
  return null;
}
