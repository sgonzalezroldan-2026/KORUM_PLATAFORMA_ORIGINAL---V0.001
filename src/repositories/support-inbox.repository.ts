import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { InboxStatus } from '@/core/support/support-inbox-rules';
import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeTenant, type SessionActor } from './tenant-guard';

/**
 * Datos de la pantalla de soporte del centro (Sprint 4.4c): las consultas que las familias dirigen a **su** entidad y las que la propia entidad ha
 * escrito a KORUM. Autoriza primero (`DIRECTOR` o `COSIGNER` de esa entidad; el Super-Admin entra con registro y sin poder contestar) y solo lee filas
 * de esa entidad. **Nunca selecciona `senderEmail`** ni lo deja salir: quien contesta no ve quién escribe. Una consulta de una familia a KORUM (`target =
 * SUPERADMIN`) guarda también el `organizationId` del centro pero no es suya, y las de la entidad (`fromOrganization`) van a su pestaña aparte.
 */

export interface InboxTicket {
  ticketCode: string;
  topic: string;
  subject: string;
  message: string;
  status: InboxStatus;
  replyMessage: string | null;
  createdAt: string;
  repliedAt: string | null;
  resolvedAt: string | null;
}

export interface SupportInboxView {
  /** Consultas de las familias a este centro: primero las que esperan (abiertas y en curso, las más antiguas arriba) y luego las resueltas. */
  families: { waiting: InboxTicket[]; resolved: InboxTicket[]; waitingCount: number };
  /** Lo que la entidad ha escrito a KORUM, lo más reciente primero. */
  sent: InboxTicket[];
}

/** Tope de consultas por lista: una entidad con muchas ve las primeras y las resueltas más recientes. */
const WAITING_LIMIT = 50;
const RESOLVED_LIMIT = 20;
const SENT_LIMIT = 20;

const TICKET_SELECT = { ticketCode: true, topic: true, subject: true, message: true, status: true, replyMessage: true, createdAt: true, repliedAt: true, resolvedAt: true } as const;

function toView(row: { ticketCode: string; topic: string; subject: string; message: string; status: InboxStatus; replyMessage: string | null; createdAt: Date; repliedAt: Date | null; resolvedAt: Date | null }): InboxTicket {
  return { ...row, createdAt: row.createdAt.toISOString(), repliedAt: row.repliedAt?.toISOString() ?? null, resolvedAt: row.resolvedAt?.toISOString() ?? null };
}

/**
 * Cuántas consultas de las familias esperan respuesta, para el contador del menú «Soporte» (como el de «Aprobaciones»). Mismo permiso que la bandeja; el
 * Super-Admin no contesta por la entidad: sin contador y sin una fila de auditoría más en cada página del panel que abre.
 */
export async function countWaitingFamilyTickets(db: KorumPrismaClient, actor: SessionActor, organizationId: string): Promise<number> {
  if (actor.kind === 'user' && actor.isSuperadmin) return 0;
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'support.inbox_count', targetType: 'SupportTicket' });
  return db.supportTicket.count({ where: { organizationId, target: 'ORGANIZATION', fromOrganization: false, status: { in: ['OPEN', 'IN_PROGRESS'] } } });
}

export async function loadSupportInbox(db: KorumPrismaClient, actor: SessionActor, organizationId: string): Promise<SupportInboxView> {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'support.inbox_read', targetType: 'SupportTicket' });
  const own = { organizationId, target: 'ORGANIZATION', fromOrganization: false } as const;
  const [waiting, resolved, waitingCount, sent] = await Promise.all([
    db.supportTicket.findMany({ where: { ...own, status: { in: ['OPEN', 'IN_PROGRESS'] } }, orderBy: { id: 'asc' }, take: WAITING_LIMIT, select: TICKET_SELECT }),
    db.supportTicket.findMany({ where: { ...own, status: 'RESOLVED' }, orderBy: { resolvedAt: 'desc' }, take: RESOLVED_LIMIT, select: TICKET_SELECT }),
    db.supportTicket.count({ where: { ...own, status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
    db.supportTicket.findMany({ where: { organizationId, fromOrganization: true }, orderBy: { id: 'desc' }, take: SENT_LIMIT, select: TICKET_SELECT })
  ]);
  return { families: { waiting: waiting.map(toView), resolved: resolved.map(toView), waitingCount }, sent: sent.map(toView) };
}
