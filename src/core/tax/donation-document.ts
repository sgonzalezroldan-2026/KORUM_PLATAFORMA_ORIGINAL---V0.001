/**
 * Qué documento recibe quien dona (Regla 02 §9). El certificado fiscal exige Ley 49/2002 verificada y el NIF y el nombre del donante; en cualquier otro
 * caso se emite un justificante nominativo, sin efectos fiscales. Las entradas y las recargas nunca dan documento de donación. Devuelve
 * solo los datos: el PDF y su envío llegan con los sprints 2.4 y 2.6.
 */

export type DonationDocumentKind = 'TAX_CERTIFICATE' | 'NOMINATIVE_RECEIPT';

export interface DocumentOrganization {
  legalName: string;
  cif: string | null;
  ley49: boolean;
  ley49VerifiedAt: Date | null;
}

export interface DocumentContribution {
  id: number;
  type: string;
  status: string;
  refundedCents: number;
  amountCents: number;
  fiscalYear: number;
  createdAt: Date;
  donorFullName: string | null;
  donorTaxIdHmac: string | null;
}

export class DonationDocumentError extends Error {
  constructor(contributionId: number) {
    super(`La aportación ${contributionId} no es una donación completada y sin reembolso.`);
    this.name = 'DonationDocumentError';
  }
}

export const isLey49Verified = (organization: Pick<DocumentOrganization, 'ley49' | 'ley49VerifiedAt'>): boolean => organization.ley49 && organization.ley49VerifiedAt !== null;

export function donationDocumentKind(organization: DocumentOrganization, contribution: Pick<DocumentContribution, 'donorTaxIdHmac' | 'donorFullName'>): DonationDocumentKind {
  return isLey49Verified(organization) && contribution.donorTaxIdHmac && contribution.donorFullName ? 'TAX_CERTIFICATE' : 'NOMINATIVE_RECEIPT';
}

/** La aportación voluntaria a KORUM no aparece: no es un donativo a la entidad. */
export function buildDonationDocument(organization: DocumentOrganization, contribution: DocumentContribution) {
  if (contribution.type !== 'DONATION' || contribution.status !== 'COMPLETED' || contribution.refundedCents > 0) throw new DonationDocumentError(contribution.id);
  return {
    kind: donationDocumentKind(organization, contribution),
    reference: `DON-${contribution.fiscalYear}-${String(contribution.id).padStart(6, '0')}`,
    organizationLegalName: organization.legalName,
    organizationTaxId: organization.cif,
    donorFullName: contribution.donorFullName,
    amountCents: contribution.amountCents,
    fiscalYear: contribution.fiscalYear,
    donatedAt: contribution.createdAt
  };
}
