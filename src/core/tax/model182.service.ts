import { dataHmac } from '@/core/security/data-hmac';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { openField, sealField } from '@/lib/encryption';
import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeTenant, ResourceNotFoundError, type SessionActor } from '@/repositories/tenant-guard';
import { buildModel182File, PROVINCE_CODES, type Model182File, type Model182Donor } from './model182-format';
import { validateTaxId } from './tax-id';

/**
 * Exportación del Modelo 182 de una entidad (Regla 02 §9, QA-REG02). Solo con la Ley 49/2002 **verificada**, y solo donaciones completadas y
 * sin reembolso: las entradas nunca, y la aportación voluntaria a KORUM tampoco, porque no es un donativo a la entidad. Sin NIF o sin
 * provincia una persona no se puede declarar: queda fuera y el resultado lo dice, para que la entidad sepa cuánto no ha entrado. Las donaciones
 * de campañas aún sin resolver entran, porque se han cobrado, pero se señalan: si la campaña falla habrá que presentar una sustitutiva.
 */

const DONOR_TAX_ID_CONTEXT = 'contribution:donorTaxId';
const DONOR_TAX_ID_HMAC_PURPOSE = 'donor-tax-id';
const UNRESOLVED_STATUSES = new Set(['FUNDRAISING', 'EXPIRED', 'RESIZE_VOTING', 'REFUNDING', 'CANCELLED']);

export class Model182NotAllowedError extends Error {
  constructor(reason: 'LEY49_NOT_VERIFIED' | 'DECLARANT_INCOMPLETE') {
    super(`No se puede exportar el Modelo 182: ${reason}.`);
    this.name = 'Model182NotAllowedError';
  }
}

/** Lo que guarda el checkout del NIF de un donante. Único sitio donde se cifra, para que el contexto coincida con el de la exportación. */
export function sealDonorTaxId(rawTaxId: string, keys: { encryptionKey: string; keyVersion: number; hmacSecret: string }) {
  const validation = validateTaxId(rawTaxId);
  if (!validation.valid) throw new RangeError('El NIF del donante no es válido.');
  return {
    donorTaxIdEnc: sealField(validation.normalized, keys.encryptionKey, DONOR_TAX_ID_CONTEXT),
    donorTaxIdHmac: dataHmac(keys.hmacSecret, DONOR_TAX_ID_HMAC_PURPOSE, validation.normalized),
    donorTaxIdKeyVersion: keys.keyVersion
  };
}

export interface Model182Export extends Model182File {
  excluded: { contributions: number; amountCents: number };
  unresolved: { contributions: number; amountCents: number };
}

export interface Model182Request {
  organizationId: string;
  fiscalYear: number;
  contactPhone: string;
  contactName: string;
  /** Si la entidad ya tiene el suyo. Por defecto, `182` + ejercicio + `000001`. */
  declarationNumber?: string;
}

export async function exportModel182(db: KorumPrismaClient, encryptionKey: string, actor: SessionActor, request: Model182Request): Promise<Model182Export> {
  const { organizationId, fiscalYear } = request;
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'tax.model182_export', targetType: 'Organization', targetId: organizationId });
  const organization = await db.organization.findUnique({ where: { id: organizationId }, select: { ley49: true, ley49VerifiedAt: true, cif: true, legalName: true } });
  if (!organization) throw new ResourceNotFoundError('Organization');
  if (!organization.ley49 || !organization.ley49VerifiedAt) {
    await db.auditLog.create({ data: { actorType: 'USER', actorUserId: actor.kind === 'user' ? actor.userId : null, organizationId, action: 'tax.model182_denied', targetType: 'Organization', targetId: organizationId, metadataJson: { fiscalYear } } });
    throw new Model182NotAllowedError('LEY49_NOT_VERIFIED');
  }
  if (!organization.cif) throw new Model182NotAllowedError('DECLARANT_INCOMPLETE');

  const rows = await db.contribution.findMany({
    where: { organizationId, type: 'DONATION', status: 'COMPLETED', refundedCents: 0, fiscalYear: { gte: fiscalYear - 3, lte: fiscalYear } },
    orderBy: { createdAt: 'asc' },
    select: { fiscalYear: true, amountCents: true, donorFullName: true, donorTaxIdEnc: true, donorTaxIdHmac: true, donorProvinceCode: true, initiative: { select: { status: true } } }
  });

  const donors = new Map<string, { sealed: string; fullName: string; provinceCode: string; byYear: Map<number, number> }>();
  const excluded = { contributions: 0, amountCents: 0 };
  const unresolved = { contributions: 0, amountCents: 0 };
  for (const row of rows) {
    const current = row.fiscalYear === fiscalYear;
    const declarable = row.donorTaxIdEnc && row.donorTaxIdHmac && row.donorFullName && row.donorProvinceCode && PROVINCE_CODES.has(row.donorProvinceCode);
    if (!declarable) {
      if (current) {
        excluded.contributions += 1;
        excluded.amountCents += row.amountCents;
      }
      continue;
    }
    if (current && UNRESOLVED_STATUSES.has(row.initiative.status)) {
      unresolved.contributions += 1;
      unresolved.amountCents += row.amountCents;
    }
    const donor = donors.get(row.donorTaxIdHmac!) ?? { sealed: row.donorTaxIdEnc!, fullName: row.donorFullName!, provinceCode: row.donorProvinceCode!, byYear: new Map<number, number>() };
    // Si cambió de domicilio o corrigió su nombre, vale el último dato: las filas vienen en orden de fecha.
    donor.sealed = row.donorTaxIdEnc!;
    donor.fullName = row.donorFullName!;
    donor.provinceCode = row.donorProvinceCode!;
    donor.byYear.set(row.fiscalYear, (donor.byYear.get(row.fiscalYear) ?? 0) + row.amountCents);
    donors.set(row.donorTaxIdHmac!, donor);
  }

  const records: Model182Donor[] = [];
  for (const donor of donors.values()) {
    const amountCents = donor.byYear.get(fiscalYear) ?? 0;
    if (amountCents === 0) continue;
    const validation = validateTaxId(openField(donor.sealed, encryptionKey, DONOR_TAX_ID_CONTEXT));
    if (!validation.valid) {
      excluded.contributions += 1;
      excluded.amountCents += amountCents;
      continue;
    }
    const year = (offset: number) => donor.byYear.get(fiscalYear - offset) ?? 0;
    records.push({ taxId: validation.normalized, kind: validation.kind, fullName: donor.fullName, provinceCode: donor.provinceCode, amountCents, previousYearsCents: [year(3), year(2), year(1)] });
  }
  records.sort((a, b) => a.taxId.localeCompare(b.taxId));

  const file = buildModel182File(
    { taxId: organization.cif, legalName: organization.legalName, contactPhone: request.contactPhone, contactName: request.contactName, fiscalYear, declarationNumber: request.declarationNumber ?? `182${fiscalYear}000001` },
    records
  );
  // Solo cifras: ningún NIF ni nombre en la auditoría.
  await db.auditLog.create({
    data: { actorType: 'USER', actorUserId: actor.kind === 'user' ? actor.userId : null, organizationId, action: 'tax.model182_exported', targetType: 'Organization', targetId: organizationId, metadataJson: { fiscalYear, donorCount: file.donorCount, totalCents: file.totalCents, excluded, unresolved } }
  });
  return { ...file, excluded, unresolved };
}
