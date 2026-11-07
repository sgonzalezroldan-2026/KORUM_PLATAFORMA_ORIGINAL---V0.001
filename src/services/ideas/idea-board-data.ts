import { displayIdeaAlias, ideaAction, ideaProgress } from '@/core/ideas/idea-rules';
import { currentConsents } from '@/core/privacy/consents';
import { ideaSignerMarker } from '@/core/security/device-quorum.service';
import type { IdeaCardData } from '@/components/ideas/idea-card';
import { getPrisma } from '@/lib/prisma';
import { getIdeaBoardRules, listIdeaIdsSignedBy, listPublicIdeas } from '@/repositories/ideas-public.repository';

/**
 * Lo que necesita la página del buzón (Sprint 3.6): las ideas visibles con su avance y lo que puede hacer esta persona con cada una, las categorías
 * y las reglas de la entidad, y si ya dio el consentimiento de la huella. Todo serializable; nada de correos, de firmas sospechosas ni de motivos de auditoría.
 */

export interface IdeaBoardData {
  needed: number;
  maxDays: number;
  categories: { name: string; icon: string }[];
  ideas: IdeaCardData[];
  fingerprintGranted: boolean;
}

export async function loadIdeaBoard(slug: string, now: Date, person: { userId: string; email: string } | null, hmacSecret: string): Promise<IdeaBoardData> {
  const db = getPrisma();
  const [rules, rows, signedIds, consents] = await Promise.all([
    getIdeaBoardRules(db, slug),
    listPublicIdeas(db, slug, now),
    person ? listIdeaIdsSignedBy(db, slug, { userId: person.userId, email: person.email, formerMarker: (canonicalEmail) => ideaSignerMarker(hmacSecret, canonicalEmail) }) : Promise.resolve(new Set<number>()),
    person ? currentConsents(db, person.userId) : Promise.resolve([])
  ]);
  const ideas: IdeaCardData[] = rows.map((row) => {
    const progress = ideaProgress(row, rules.minVotes, now);
    return {
      id: row.id,
      alias: displayIdeaAlias(row.alias),
      title: row.title,
      category: row.category,
      description: row.description,
      phase: row.phase === 'DOUBLE_CHECK' ? 'DOUBLE_CHECK' : 'PUBLIC_VOTING',
      verifiedVotes: row.verifiedVotes,
      percent: progress.percent,
      quorumReached: progress.quorumReached,
      daysRemaining: progress.daysRemaining,
      action: ideaAction(row.phase, signedIds.has(row.id), row.expiresAt, now)
    };
  });
  return {
    needed: rules.minVotes,
    maxDays: rules.maxIdeaDays,
    categories: rules.categories,
    ideas,
    fingerprintGranted: consents.some((consent) => consent.purpose === 'DEVICE_FINGERPRINT' && consent.granted)
  };
}
