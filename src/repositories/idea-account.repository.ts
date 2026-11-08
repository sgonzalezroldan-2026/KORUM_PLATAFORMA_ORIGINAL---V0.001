import type { Db } from '@/lib/db';

/**
 * Lecturas de *Mi cuenta* sobre el buzón de ideas (Sprint 3.9): las propuestas de la persona con su chat anónimo y las ideas que ha firmado, en
 * todas sus comunidades. Quién es la persona sale siempre de la sesión: aquí solo llegan su `userId` y su email canónico verificado. Nunca se
 * leen el correo de otra persona, los motivos de la auditoría ni el estado de la firma (una firma «en revisión» no se le dice a quien la hizo).
 */

/** Tope de ideas de cada lista en pantalla: una persona tiene como mucho 5 abiertas a la vez, pero guarda las cerradas. */
export const ACCOUNT_IDEAS_LIMIT = 50;
/** Tope de mensajes leídos por idea: el de la familia (60) más las respuestas del centro. */
export const CHAT_MESSAGES_READ_LIMIT = 200;

const IDEA_SUMMARY = {
  id: true,
  alias: true,
  title: true,
  category: true,
  phase: true,
  verifiedVotes: true,
  expiresAt: true,
  createdAt: true,
  organization: { select: { slug: true, name: true, minVotes: true } }
} as const;

/** Las ideas que esta persona propuso (por su email canónico verificado), con su chat entero, las más recientes primero. */
export function listProposalsOf(db: Db, canonicalEmail: string) {
  return db.idea.findMany({
    where: { authorCanonicalEmail: canonicalEmail, organization: { archivedAt: null } },
    // Los más recientes (con tope): si la conversación es larguísima, lo que se pierde son los mensajes viejos, nunca las respuestas nuevas del centro.
    select: { ...IDEA_SUMMARY, messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: CHAT_MESSAGES_READ_LIMIT, select: { id: true, senderRole: true, senderLabel: true, body: true, createdAt: true } } },
    orderBy: { id: 'desc' },
    take: ACCOUNT_IDEAS_LIMIT
  });
}

/**
 * Las ideas que firmó, por cuenta, por email canónico y por la marca anónima que dejó una supresión anterior (quien vuelve con el mismo email
 * sigue viendo lo que firmó). Las que propuso van aparte, en sus propuestas.
 */
export async function listSignedIdeasOf(db: Db, person: { userId: string; canonicalEmails: string[] }) {
  const signatures = await db.ideaSignatureAudit.findMany({
    where: { OR: [{ userId: person.userId }, ...(person.canonicalEmails.length ? [{ canonicalEmail: { in: person.canonicalEmails } }] : [])], idea: { organization: { archivedAt: null }, NOT: { authorCanonicalEmail: { in: person.canonicalEmails } } } },
    select: { createdAt: true, idea: { select: IDEA_SUMMARY } },
    orderBy: { id: 'desc' },
    take: ACCOUNT_IDEAS_LIMIT
  });
  const seen = new Set<number>();
  return signatures.filter((row) => !seen.has(row.idea.id) && Boolean(seen.add(row.idea.id))).map((row) => ({ ...row.idea, signedAt: row.createdAt }));
}

/** Una idea **de esta persona** con lo mínimo para escribir en su chat. Una ajena responde igual que una inexistente. */
export function findOwnIdeaForChat(db: Db, ideaId: number, canonicalEmail: string) {
  return db.idea.findFirst({
    where: { id: ideaId, authorCanonicalEmail: canonicalEmail, organization: { archivedAt: null } },
    select: { id: true, alias: true, phase: true, organizationId: true }
  });
}

/** Mensajes del chat de una idea, en orden, para decidir si la familia puede escribir. */
export function listChatRoles(db: Db, ideaId: number) {
  return db.ideaMessage.findMany({ where: { ideaId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { senderRole: true } });
}

/** Cuántas propuestas y firmas tiene la persona, para el resumen de *Mi cuenta* (sin leer ningún chat). */
export async function countIdeasOf(db: Db, person: { userId: string; canonicalEmails: string[] }) {
  const [proposals, signed] = await Promise.all([
    db.idea.count({ where: { authorCanonicalEmail: { in: person.canonicalEmails.slice(0, 1) }, organization: { archivedAt: null } } }),
    db.ideaSignatureAudit.count({ where: { OR: [{ userId: person.userId }, { canonicalEmail: { in: person.canonicalEmails } }], idea: { organization: { archivedAt: null }, NOT: { authorCanonicalEmail: { in: person.canonicalEmails } } } } })
  ]);
  // La entidad de la idea más reciente (propia o firmada): a ella lleva el enlace a «FAQ y soporte» de quien aún no ha aportado.
  const latest = await db.idea.findFirst({
    where: { organization: { archivedAt: null }, OR: [{ authorCanonicalEmail: { in: person.canonicalEmails } }, { signatures: { some: { OR: [{ userId: person.userId }, { canonicalEmail: { in: person.canonicalEmails } }] } } }] },
    orderBy: { id: 'desc' },
    select: { organization: { select: { slug: true } } }
  });
  return { proposals, signed, organizationSlug: latest?.organization.slug ?? null };
}
