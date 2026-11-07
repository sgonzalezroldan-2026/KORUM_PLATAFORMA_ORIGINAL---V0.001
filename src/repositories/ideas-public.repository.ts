import { ideaCategories } from '@/core/ideas/idea-rules';
import { normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import type { Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { ResourceNotFoundError } from './tenant-guard';

/**
 * Lecturas PÚBLICAS del buzón de ideas y de los logros (Entorno 1, Sprint 3.6). Como el resto de `public.repository.ts`: solo campos pensados
 * para ser públicos y siempre junto a la entidad por su `orgSlug`. Una idea se enseña con su alias anónimo (`#FAM-XXXX`) y el recuento de firmas
 * **verificadas**; nunca el correo de quien la propone, los motivos de la auditoría ni las firmas sospechosas.
 */

const PUBLIC_IDEA_VIEW = {
  id: true,
  alias: true,
  title: true,
  category: true,
  description: true,
  phase: true,
  verifiedVotes: true,
  expiresAt: true,
  createdAt: true
} as const;

/** Tope de ideas en pantalla: un buzón con más ideas abiertas que esto necesita paginar (y moderación, Sprint 4.2). */
export const PUBLIC_IDEAS_LIMIT = 60;

/**
 * Tipos de mejora en los que puede clasificarse una idea: las categorías globales de la plataforma más las propias de la entidad (como el
 * prototipo, `getEffectiveCategoriesForSchool`), sin repetir nombres y sin la de taquilla y rifas, que no es una mejora.
 */
export async function listIdeaCategoryOptions(db: Db, organizationId: string): Promise<{ name: string; icon: string }[]> {
  const [global, custom] = await Promise.all([
    db.globalCategory.findMany({ select: { name: true, icon: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    db.organizationCategory.findMany({ where: { organizationId }, select: { name: true, icon: true }, orderBy: { id: 'asc' } })
  ]);
  const seen = new Set<string>();
  return ideaCategories([...global, ...custom]).filter((category) => !seen.has(category.name) && Boolean(seen.add(category.name)));
}

/** Lo que decide el buzón de una entidad: el mínimo de firmas, los días de plazo y los tipos de mejora disponibles. */
export async function getIdeaBoardRules(db: KorumPrismaClient, slug: string) {
  const organization = await db.organization.findFirst({ where: { slug, archivedAt: null }, select: { id: true, minVotes: true, maxIdeaDays: true } });
  if (!organization) throw new ResourceNotFoundError('Entidad');
  return { ...organization, categories: await listIdeaCategoryOptions(db, organization.id) };
}

/**
 * Ideas que las familias pueden ver: las que reúnen firmas (`PUBLIC_VOTING` dentro de plazo) y las que ya tienen quórum y esperan la doble firma
 * del centro (`DOUBLE_CHECK`). Las que aún revisa el centro (`PHASE0_MOD`), las convertidas en iniciativa y las rechazadas no salen.
 */
export async function listPublicIdeas(db: KorumPrismaClient, slug: string, now: Date) {
  return db.idea.findMany({
    where: {
      organization: { slug, archivedAt: null },
      OR: [{ phase: 'PUBLIC_VOTING', expiresAt: { gt: now } }, { phase: 'DOUBLE_CHECK' }]
    },
    select: PUBLIC_IDEA_VIEW,
    orderBy: [{ phase: 'asc' }, { verifiedVotes: 'desc' }, { id: 'desc' }],
    take: PUBLIC_IDEAS_LIMIT
  });
}

/**
 * Ideas de esta entidad que esta persona ya firmó o propuso (quien propone cuenta como su primera firma). La búsqueda se hace por `userId`, por
 * el email canónico de la cuenta y por la marca anónima que dejó una supresión anterior: quien vuelve con el mismo email sigue viendo «Ya has
 * firmado».
 */
export async function listIdeaIdsSignedBy(db: KorumPrismaClient, slug: string, person: { userId: string; email: string; formerMarker: (canonicalEmail: string) => string }): Promise<Set<number>> {
  let canonicalEmail: string | null = null;
  try {
    canonicalEmail = normalizeCanonicalEmail(person.email);
  } catch {
    // Un email que no se puede normalizar no firmó nada por ese medio: solo cuenta la firma por cuenta.
  }
  const emails = canonicalEmail ? [canonicalEmail, person.formerMarker(canonicalEmail)] : [];
  const [signatures, authored] = await Promise.all([
    db.ideaSignatureAudit.findMany({ where: { idea: { organization: { slug, archivedAt: null } }, OR: [{ userId: person.userId }, ...(emails.length ? [{ canonicalEmail: { in: emails } }] : [])] }, select: { ideaId: true } }),
    emails.length ? db.idea.findMany({ where: { organization: { slug, archivedAt: null }, authorCanonicalEmail: { in: emails } }, select: { id: true } }) : Promise.resolve([])
  ]);
  return new Set([...signatures.map((row) => row.ideaId), ...authored.map((row) => row.id)]);
}

/** Cuántas propuestas ha hecho esta persona en la entidad (hoy y todavía abiertas), para el límite del buzón. */
export async function countIdeasAuthoredBy(db: Db, organizationId: string, canonicalEmail: string, since: Date) {
  const [recent, open] = await Promise.all([
    db.idea.count({ where: { organizationId, authorCanonicalEmail: canonicalEmail, createdAt: { gte: since } } }),
    db.idea.count({ where: { organizationId, authorCanonicalEmail: canonicalEmail, phase: { in: ['PHASE0_MOD', 'PUBLIC_VOTING', 'DOUBLE_CHECK'] } } })
  ]);
  return { recent, open };
}

/** Alias ya usados en la entidad: el código de cada idea es único dentro de ella (el chat anónimo del 3.7 se identifica por él). */
export async function listUsedIdeaAliases(db: Db, organizationId: string): Promise<Set<string>> {
  const rows = await db.idea.findMany({ where: { organizationId }, select: { alias: true } });
  return new Set(rows.map((row) => row.alias));
}
