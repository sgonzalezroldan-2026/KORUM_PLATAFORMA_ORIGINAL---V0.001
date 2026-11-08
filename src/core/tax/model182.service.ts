import type { Keyring } from '@/core/security/crypto';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeTenant, ResourceNotFoundError, type SessionActor } from '@/repositories/tenant-guard';
import { buildModel182File, PROVINCE_CODES, type Model182File, type Model182Donor } from './model182-format';
import { validateTaxId } from './tax-id';
import { openDonorTaxId } from './tax-id-vault';

export { sealDonorTaxId } from './tax-id-vault';

/**
 * Exportación del Modelo 182 de una entidad (Regla 02 §9, QA-REG02). Solo con la Ley 49/2002 **verificada**, y solo donaciones completadas y
 * sin reembolso: las entradas nunca, y la aportación voluntaria a KORUM tampoco, porque no es un donativo a la entidad. Sin NIF o sin
 * provincia una persona no se puede declarar: queda fuera y el resultado lo dice, para que la entidad sepa cuánto no ha entrado. Las donaciones
 * de campañas aún sin resolver entran, porque se han cobrado, pero se señalan; las de campañas que ya se devuelven o se cancelaron no entran.
 */

const UNRESOLVED_STATUSES = new Set(['FUNDRAISING', 'EXPIRED', 'RESIZE_VOTING']);
/** Campañas que ya se devuelven o se cancelaron: ese dinero no es un donativo irrevocable (Ley 49/2002, art. 24), así que no se declara. */
const RETURNED_STATUSES = new Set(['REFUNDING', 'CANCELLED']);

export class Model182NotAllowedError extends Error {
  constructor(readonly reason: 'LEY49_NOT_VERIFIED' | 'DECLARANT_INCOMPLETE') {
    super(`No se puede exportar el Modelo 182: ${reason}.`);
    this.name = 'Model182NotAllowedError';
  }
}

export interface Model182Export extends Model182File {
  excluded: { contributions: number; amountCents: number };
  unresolved: { contributions: number; amountCents: number };
  /** Donaciones de campañas que se están devolviendo o se cancelaron: no entran en el fichero. */
  returned: { contributions: number; amountCents: number };
}

export interface Model182Request {
  organizationId: string;
  fiscalYear: number;
  contactPhone: string;
  contactName: string;
  /** Si la entidad ya tiene el suyo. Por defecto, `182` + ejercicio + `000001`. */
  declarationNumber?: string;
}

export async function exportModel182(db: KorumPrismaClient, keyring: Keyring, actor: SessionActor, request: Model182Request): Promise<Model182Export> {
  const { organizationId, fiscalYear } = request;
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'tax.model182_export', targetType: 'Organization', targetId: organizationId, allowSuperadmin: false });
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
    select: { fiscalYear: true, amountCents: true, donorFullName: true, donorTaxIdEnc: true, donorTaxIdHmac: true, donorTaxIdKeyVersion: true, donorProvinceCode: true, initiative: { select: { status: true } } }
  });

  const donors = new Map<string, { sealed: string; keyVersion: number | null; fullName: string; provinceCode: string; byYear: Map<number, number> }>();
  const excluded = { contributions: 0, amountCents: 0 };
  const unresolved = { contributions: 0, amountCents: 0 };
  const returned = { contributions: 0, amountCents: 0 };
  for (const row of rows) {
    const current = row.fiscalYear === fiscalYear;
    if (RETURNED_STATUSES.has(row.initiative.status)) {
      if (current) {
        returned.contributions += 1;
        returned.amountCents += row.amountCents;
      }
      continue;
    }
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
    const donor = donors.get(row.donorTaxIdHmac!) ?? { sealed: row.donorTaxIdEnc!, keyVersion: row.donorTaxIdKeyVersion, fullName: row.donorFullName!, provinceCode: row.donorProvinceCode!, byYear: new Map<number, number>() };
    // Si cambió de domicilio o corrigió su nombre, vale el último dato: las filas vienen en orden de fecha.
    donor.sealed = row.donorTaxIdEnc!;
    donor.keyVersion = row.donorTaxIdKeyVersion;
    donor.fullName = row.donorFullName!;
    donor.provinceCode = row.donorProvinceCode!;
    donor.byYear.set(row.fiscalYear, (donor.byYear.get(row.fiscalYear) ?? 0) + row.amountCents);
    donors.set(row.donorTaxIdHmac!, donor);
  }

  const records: Model182Donor[] = [];
  for (const donor of donors.values()) {
    const amountCents = donor.byYear.get(fiscalYear) ?? 0;
    if (amountCents === 0) continue;
    const validation = validateTaxId(openDonorTaxId(keyring, donor.sealed, donor.keyVersion));
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
    data: { actorType: 'USER', actorUserId: actor.kind === 'user' ? actor.userId : null, organizationId, action: 'tax.model182_exported', targetType: 'Organization', targetId: organizationId, metadataJson: { fiscalYear, donorCount: file.donorCount, totalCents: file.totalCents, excluded, unresolved, returned } }
  });
  return { ...file, excluded, unresolved, returned };
}
