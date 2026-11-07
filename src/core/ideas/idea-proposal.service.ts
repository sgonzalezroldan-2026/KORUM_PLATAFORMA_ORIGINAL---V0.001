import { canonicalEmailOf, IdeaSignatureRejectedError } from '@/core/security/device-quorum.service';
import { inTransaction, type Db } from '@/lib/db';
import { countIdeasAuthoredBy, listIdeaCategoryOptions, listUsedIdeaAliases } from '@/repositories/ideas-public.repository';
import { generateIdeaAlias, IDEAS_OPEN_PER_PERSON, IDEAS_PER_PERSON_PER_DAY, proposeIdeaSchema } from './idea-rules';

/**
 * Proponer una idea al buzón (Sprint 3.6, QA-F09). Quien propone sale de la sesión: su email verificado se guarda como `authorCanonicalEmail`
 * (para que no pueda firmar su propia idea otra vez y para el límite de propuestas) y **nunca se enseña**; en público solo existe el alias
 * `#FAM-XXXX`, generado aquí. La idea nace en `PHASE0_MOD`: el centro la revisa antes de abrir las firmas (moderación = Sprint 4.2), y quien la
 * propone cuenta como su primera firma verificada.
 */

export type IdeaProposalRejection = 'INVALID_INPUT' | 'ORGANIZATION_NOT_FOUND' | 'INVALID_CATEGORY' | 'TOO_MANY_TODAY' | 'TOO_MANY_OPEN' | 'ALIAS_EXHAUSTED' | 'ACCOUNT_NOT_ALLOWED';

export class IdeaProposalRejectedError extends Error {
  readonly reason: IdeaProposalRejection;

  constructor(reason: IdeaProposalRejection) {
    super(`La propuesta no se puede registrar: ${reason}.`);
    this.name = 'IdeaProposalRejectedError';
    this.reason = reason;
  }
}

const DAY_MS = 86_400_000;
const ALIAS_ATTEMPTS = 25;

export interface ProposedIdea {
  ideaId: number;
  alias: string;
}

/**
 * @param systemMessage Texto del primer mensaje del historial («Propuesta registrada con #FAM-1234…»), ya en el idioma de la persona: el alias
 *   se sustituye aquí en el marcador `{alias}`.
 */
export async function proposeIdea(db: Db, input: { userId: string; payload: unknown; systemMessage: string; random?: (max: number) => number }, now: Date = new Date()): Promise<ProposedIdea> {
  const parsed = proposeIdeaSchema.safeParse(input.payload);
  if (!parsed.success) throw new IdeaProposalRejectedError('INVALID_INPUT');
  const proposal = parsed.data;

  return inTransaction(db, async (tx) => {
    // Bloquea a la persona: dos propuestas a la vez no pueden esquivar el límite diario ni repartirse el mismo alias.
    const user = await tx.user.update({ where: { id: input.userId }, data: { updatedAt: now }, select: { email: true, emailVerified: true, gdprAnonymizedAt: true } });
    let canonicalEmail: string;
    try {
      canonicalEmail = canonicalEmailOf(user);
    } catch (error) {
      if (error instanceof IdeaSignatureRejectedError) throw new IdeaProposalRejectedError('ACCOUNT_NOT_ALLOWED');
      throw error;
    }

    const organization = await tx.organization.findFirst({
      where: { slug: proposal.orgSlug, archivedAt: null },
      select: { id: true, maxIdeaDays: true }
    });
    if (!organization) throw new IdeaProposalRejectedError('ORGANIZATION_NOT_FOUND');
    if (!(await listIdeaCategoryOptions(tx, organization.id)).some((category) => category.name === proposal.category)) throw new IdeaProposalRejectedError('INVALID_CATEGORY');

    const { recent, open } = await countIdeasAuthoredBy(tx, organization.id, canonicalEmail, new Date(now.getTime() - DAY_MS));
    if (recent >= IDEAS_PER_PERSON_PER_DAY) throw new IdeaProposalRejectedError('TOO_MANY_TODAY');
    if (open >= IDEAS_OPEN_PER_PERSON) throw new IdeaProposalRejectedError('TOO_MANY_OPEN');

    const used = await listUsedIdeaAliases(tx, organization.id);
    let alias: string | null = null;
    for (let attempt = 0; attempt < ALIAS_ATTEMPTS && alias === null; attempt += 1) {
      const candidate = generateIdeaAlias(input.random);
      // El código antiguo («Código #FAM-1234») también cuenta como usado: el de ahora no puede repetir sus cuatro cifras.
      if (![...used].some((existing) => existing.includes(candidate))) alias = candidate;
    }
    if (alias === null) throw new IdeaProposalRejectedError('ALIAS_EXHAUSTED');

    const idea = await tx.idea.create({
      data: {
        organizationId: organization.id,
        alias,
        authorCanonicalEmail: canonicalEmail,
        title: proposal.title,
        category: proposal.category,
        description: proposal.description,
        phase: 'PHASE0_MOD',
        votes: 1,
        verifiedVotes: 1,
        suspiciousVotes: 0,
        expiresAt: new Date(now.getTime() + organization.maxIdeaDays * DAY_MS),
        createdAt: now,
        messages: { create: { senderRole: 'SYSTEM', senderLabel: 'KORUM', body: input.systemMessage.replace('{alias}', alias), createdAt: now } }
      },
      select: { id: true }
    });
    return { ideaId: idea.id, alias };
  });
}
