import { currentConsents } from '@/core/privacy/consents';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { donationDocumentKind, type DonationDocumentKind } from '@/core/tax/donation-document';
import type { Prisma } from '@/generated/prisma/client';
import type { Db } from '@/lib/db';

/**
 * Lecturas de *Mi cuenta* (Sprint 3.7). Todas reciben el `userId` **de la sesión** (`getAuthSession`), nunca uno enviado por el navegador, y
 * solo devuelven lo de esa persona: no hay `organizationId` que autorizar, el dueño del dato es la propia cuenta.
 *
 * Qué es «mío»: lo aportado con la cuenta y —solo si su email está verificado— lo comprado como invitada con ese mismo email (email canónico).
 * Es el mismo criterio que la exportación y la supresión (`personal-data-export.ts`, `erasure.service.ts`): lo que se enseña aquí es lo que se
 * exporta y lo que se borra.
 */

export interface AccountOwner {
  id: string;
  canonicalEmail: string;
  emailVerified: boolean;
}

export function ownContributionsWhere(owner: AccountOwner): Prisma.ContributionWhereInput {
  return owner.emailVerified ? { OR: [{ userId: owner.id }, { canonicalEmail: owner.canonicalEmail }] } : { userId: owner.id };
}

/** Cuántas filas enseña cada lista. La exportación da siempre el historial completo. */
export const ACCOUNT_LIST_LIMIT = 50;

/** Donación que da documento: completada y sin ninguna devolución (Regla 02 §8; entradas y recargas nunca). */
const DOCUMENT_DONATION = { type: 'DONATION', status: 'COMPLETED', refundedCents: 0 } as const satisfies Prisma.ContributionWhereInput;

export class AccountNotFoundError extends Error {
  constructor() {
    super('La cuenta no existe o está suprimida');
    this.name = 'AccountNotFoundError';
  }
}

/** Titular de la sesión. Una cuenta suprimida no tiene *Mi cuenta*. */
export async function loadAccountOwner(db: Db, userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, canonicalEmail: true, emailVerified: true, locale: true, twoFactorEnabled: true, isSuperadmin: true, gdprAnonymizedAt: true }
  });
  if (!user || user.gdprAnonymizedAt) throw new AccountNotFoundError();
  return user;
}

export async function loadAccountOverview(db: Db, userId: string) {
  const owner = await loadAccountOwner(db, userId);
  const mine = ownContributionsWhere(owner);
  const [contributions, passes, consents, requests, passkeys, signerRoles, documents] = await Promise.all([
    db.contribution.findMany({
      where: { AND: [mine, { type: { in: ['DONATION', 'TICKET'] } }, { status: { not: 'FAILED' } }] },
      orderBy: { id: 'desc' },
      take: ACCOUNT_LIST_LIMIT,
      select: {
        id: true,
        createdAt: true,
        type: true,
        status: true,
        amountCents: true,
        guaranteeContributionCents: true,
        totalChargedCents: true,
        refundedCents: true,
        groupName: true,
        initiative: { select: { id: true, title: true } },
        organization: { select: { slug: true, name: true } }
      }
    }),
    db.ticketPass.findMany({
      where: { contribution: { AND: [mine, { status: { in: ['COMPLETED', 'REFUND_PENDING', 'REFUNDED', 'CHARGEBACK'] } }] } },
      orderBy: { id: 'desc' },
      take: ACCOUNT_LIST_LIMIT,
      select: {
        uuid: true,
        serialCode: true,
        subtype: true,
        quantity: true,
        raffleNumbers: true,
        revokedAt: true,
        initiative: { select: { title: true, closesAt: true, ticketVenue: true, organization: { select: { slug: true, name: true } } } }
      }
    }),
    currentConsents(db, userId),
    db.privacyRequest.findMany({ where: { userId }, orderBy: { id: 'desc' }, take: 10, select: { id: true, type: true, status: true, createdAt: true, completedAt: true } }),
    db.passkey.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, createdAt: true, deviceType: true, backedUp: true } }),
    db.organizationMember.count({ where: { userId, role: { in: [...SIGNER_ROLES] } } }),
    db.contribution.count({ where: { AND: [mine, DOCUMENT_DONATION] } })
  ]);
  return {
    profile: { name: owner.name, email: owner.email, locale: owner.locale, twoFactorEnabled: owner.twoFactorEnabled, emailVerified: owner.emailVerified },
    // Lo que hoy impediría suprimir la cuenta, para explicarlo antes de pedir el código (el servicio lo vuelve a comprobar).
    erasureBlock: owner.isSuperadmin ? ('SUPERADMIN_ACCOUNT' as const) : signerRoles > 0 ? ('ACTIVE_SIGNER' as const) : null,
    contributions,
    passes,
    fingerprintConsent: consents.find((consent) => consent.purpose === 'DEVICE_FINGERPRINT') ?? null,
    privacyRequests: requests,
    passkeys,
    documentCount: documents
  };
}

export type AccountOverview = Awaited<ReturnType<typeof loadAccountOverview>>;

const documentSelect = {
  id: true,
  amountCents: true,
  fiscalYear: true,
  createdAt: true,
  type: true,
  status: true,
  refundedCents: true,
  donorFullName: true,
  donorTaxIdHmac: true,
  donorTaxIdEnc: true,
  donorTaxIdKeyVersion: true,
  donorProvinceCode: true,
  initiative: { select: { title: true } },
  organization: { select: { name: true, legalName: true, cif: true, ley49: true, ley49VerifiedAt: true } }
} as const satisfies Prisma.ContributionSelect;

export interface DocumentListItem {
  id: number;
  fiscalYear: number;
  createdAt: Date;
  amountCents: number;
  kind: DonationDocumentKind;
  organizationName: string;
  initiativeTitle: string;
}

/** Donaciones con documento, agrupadas por ejercicio (el más reciente primero). Solo las de esta persona. */
export async function listDonationDocuments(db: Db, userId: string): Promise<Array<{ fiscalYear: number; items: DocumentListItem[] }>> {
  const owner = await loadAccountOwner(db, userId);
  const rows = await db.contribution.findMany({ where: { AND: [ownContributionsWhere(owner), DOCUMENT_DONATION] }, orderBy: [{ fiscalYear: 'desc' }, { id: 'desc' }], select: documentSelect });
  const years = new Map<number, DocumentListItem[]>();
  for (const row of rows) {
    const items = years.get(row.fiscalYear) ?? [];
    items.push({
      id: row.id,
      fiscalYear: row.fiscalYear,
      createdAt: row.createdAt,
      amountCents: row.amountCents,
      kind: donationDocumentKind(row.organization, row),
      organizationName: row.organization.name,
      initiativeTitle: row.initiative.title
    });
    years.set(row.fiscalYear, items);
  }
  return [...years.entries()].map(([fiscalYear, items]) => ({ fiscalYear, items }));
}

/** Una donación con documento, solo si es de esta persona: la de otra cuenta responde igual que una que no existe (`null`). */
export async function findOwnDonationDocument(db: Db, userId: string, contributionId: number) {
  const owner = await loadAccountOwner(db, userId);
  return db.contribution.findFirst({ where: { AND: [{ id: contributionId }, ownContributionsWhere(owner), DOCUMENT_DONATION] }, select: documentSelect });
}

export type OwnDonationDocument = NonNullable<Awaited<ReturnType<typeof findOwnDonationDocument>>>;
