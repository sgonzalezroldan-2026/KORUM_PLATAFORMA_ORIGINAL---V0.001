import type { Db } from '@/lib/db';

/**
 * Lo que cuelga del email de una cuenta y pasa con él cuando cambia (decisión 88, Sprint 5.10b): consultas de soporte, compras hechas sin cuenta y sus entradas y vales,
 * ideas propuestas, emails recibidos (quedan unidos a la cuenta), dispositivos del buzón y el email de contacto de la entidad que dirige. Lo usan el cambio de email y
 * el enlace «No he sido yo», que lo devuelve al email anterior. Siempre dentro de la transacción del cambio, con la cuenta bloqueada.
 *
 * No se tocan las firmas de ideas (siguen unidas a la cuenta) ni los votos de redimensionamiento (su guarda solo admite anonimizar el email: el voto se reconoce también
 * por su donación, `votedWith`).
 */
export type MovedRecords = { tickets: number; purchases: number; passes: number; ideas: number; emails: number };

export async function moveEmailLinks(tx: Db, userId: string, from: { email: string; canonical: string }, to: { email: string; canonical: string }): Promise<MovedRecords> {
  // Las entradas y vales se localizan por su compra antes de que la compra cambie de email.
  const passes = await tx.ticketPass.updateMany({ where: { OR: [{ holderEmail: from.email }, { contribution: { canonicalEmail: from.canonical } }], NOT: { holderEmail: { startsWith: 'anonimizado:' } } }, data: { holderEmail: to.email } });
  const guest = await tx.contribution.updateMany({ where: { canonicalEmail: from.canonical, guestEmail: { not: null } }, data: { canonicalEmail: to.canonical, guestEmail: to.email } });
  const own = await tx.contribution.updateMany({ where: { canonicalEmail: from.canonical, guestEmail: null }, data: { canonicalEmail: to.canonical } });
  const ideas = await tx.idea.updateMany({ where: { authorCanonicalEmail: from.canonical }, data: { authorCanonicalEmail: to.canonical } });
  // Consultas: las de su autora y las anteriores al 5.10b sin autora guardada que se escribieron con el email de partida.
  const tickets = await tx.supportTicket.updateMany({ where: { OR: [{ senderUserId: userId }, { senderUserId: null, senderEmail: from.email }] }, data: { senderEmail: to.email, senderUserId: userId } });
  // Los emails ya enviados conservan su destinatario, pero quedan unidos a la cuenta: así no salen en la copia de datos de quien use después el email de partida.
  const emails = await tx.outboxMessage.updateMany({ where: { toAddress: from.email, userId: null }, data: { userId } });
  await tx.deviceAccount.updateMany({ where: { userId }, data: { canonicalEmail: to.canonical } });
  // El email de contacto de la entidad que dirige, si era este (tabla de plazos §3.9).
  await tx.organization.updateMany({ where: { contactEmail: from.email, members: { some: { userId, role: 'DIRECTOR' } } }, data: { contactEmail: to.email } });
  return { tickets: tickets.count, purchases: guest.count + own.count, passes: passes.count, ideas: ideas.count, emails: emails.count };
}
