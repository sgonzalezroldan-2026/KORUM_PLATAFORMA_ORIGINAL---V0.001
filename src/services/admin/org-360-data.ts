import { pickTariffValues, type TariffValues } from '@/core/admin/org-360-rules';
import { kybReadiness, type KybReadiness } from '@/core/panel/entity-settings-rules';
import { maskEmail } from '@/core/panel/team-rules';
import type { Db } from '@/lib/db';
import { loadBiSnapshot, type BiSnapshot } from './bi-snapshot';

/**
 * Lecturas de la ficha 360º (Sprint 5.2). Quien llama ya pasó `authorizeSuperadmin`. Lo personal sale recortado: el email de quien firma, a medias; el IBAN,
 * solo sus últimos cuatro dígitos; de un documento del titular, solo su tipo y su fecha (abrirlo es una operación aparte, con registro). Las cifras de
 * negocio salen del mismo BI de `/admin` filtrado por entidad, así que no pueden diferir de las de las tablas.
 */

export type { TariffValues };

export interface OrgSeatView {
  id: number;
  role: 'DIRECTOR' | 'COSIGNER';
  roleLabel: string | null;
  name: string;
  maskedEmail: string;
  twoFactor: boolean;
  /** Desde cuándo tiene el cargo: sirve para ver quién es nuevo desde una baja. */
  since: string;
}

export interface OrgCategoryView {
  name: string;
  icon: string;
  rule: 'EXEMPT' | 'BRACKETS';
  /** `GLOBAL`: tal como la define la plataforma; `OVERRIDE`: una global con la regla de esta entidad; `CUSTOM`: propia de la entidad. */
  source: 'GLOBAL' | 'OVERRIDE' | 'CUSTOM';
}

export interface OrgInvoiceView {
  id: number;
  invoiceNumber: string;
  issuedAt: string;
  invoiceType: string;
  concept: string;
  totalAmountCents: number;
  verifactuStatus: string;
}

export interface Org360View {
  organization: {
    id: string;
    slug: string;
    name: string;
    legalName: string;
    legalForm: string;
    vertical: string;
    province: string;
    city: string | null;
    cif: string | null;
    /** `ES•• •••• 1234`: solo los últimos cuatro caracteres. */
    ibanHint: string | null;
    walletId: string;
    splitConfigured: boolean;
    kybStatus: 'PENDING' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED';
    kybSubmittedAt: string | null;
    kybReviewedAt: string | null;
    kybReviewNote: string | null;
    ley49: boolean;
    ley49VerifiedAt: string | null;
    medalRank: number;
    completedThisYear: number;
    completedHistorical: number;
    activeSponsorsCount: number;
    historicalSponsorsCount: number;
    archived: boolean;
    /** Cuántas firmas exige la entidad (la elige ella misma): solo se consulta, el Super-Admin no la cambia. */
    signatureMode: 'DOUBLE' | 'SINGLE';
  };
  documents: Array<{ id: number; kind: string; createdAt: string }>;
  readiness: KybReadiness;
  seats: OrgSeatView[];
  handover: { id: string; role: 'DIRECTOR' | 'COSIGNER'; expiresAt: string; expired: boolean } | null;
  customRules: boolean;
  tariffs: TariffValues;
  globalTariffs: TariffValues;
  categories: OrgCategoryView[];
  invoices: OrgInvoiceView[];
  business: BiSnapshot;
}

const hint = (iban: string | null) => {
  if (!iban) return null;
  const compact = iban.replace(/\s+/g, '');
  return compact.length < 8 ? '••••' : `${compact.slice(0, 2)}•• •••• ${compact.slice(-4)}`;
};

const MAX_INVOICES = 100;

export async function loadOrganization360(db: Db, organizationId: string, now: Date = new Date()): Promise<Org360View | null> {
  const organization = await db.organization.findUnique({ where: { id: organizationId } });
  if (!organization) return null;
  const [documents, members, handover, globalConfig, globalCategories, ownCategories, invoices, business] = await Promise.all([
    db.kybDocument.findMany({ where: { organizationId, replacedAt: null }, orderBy: { id: 'asc' }, select: { id: true, kind: true, createdAt: true } }),
    db.organizationMember.findMany({ where: { organizationId, role: { in: ['DIRECTOR', 'COSIGNER'] }, user: { gdprAnonymizedAt: null } }, orderBy: { id: 'asc' }, select: { id: true, role: true, roleLabel: true, createdAt: true, user: { select: { name: true, email: true, twoFactorEnabled: true } } } }),
    db.signerHandover.findFirst({ where: { organizationId, status: 'INVITED' }, select: { id: true, role: true, expiresAt: true } }),
    db.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' } }),
    db.globalCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { name: true, icon: true, rule: true } }),
    db.organizationCategory.findMany({ where: { organizationId }, orderBy: { id: 'asc' }, select: { name: true, icon: true, rule: true, isCustom: true } }),
    db.invoice.findMany({ where: { organizationId }, orderBy: { id: 'desc' }, take: MAX_INVOICES, select: { id: true, invoiceNumber: true, issuedAt: true, invoiceType: true, concept: true, totalAmountCents: true, verifactuStatus: true } }),
    loadBiSnapshot(db, { organizationId })
  ]);

  // Una categoría propia con el mismo nombre que una global manda sobre ella (como en el Estudio).
  const byName = new Map<string, OrgCategoryView>(globalCategories.map((category) => [category.name, { ...category, source: 'GLOBAL' }]));
  for (const category of ownCategories) byName.set(category.name, { name: category.name, icon: category.icon, rule: category.rule, source: byName.has(category.name) ? 'OVERRIDE' : 'CUSTOM' });

  return {
    organization: {
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      legalName: organization.legalName,
      legalForm: organization.legalForm,
      vertical: organization.vertical,
      province: organization.province,
      city: organization.city,
      cif: organization.cif,
      ibanHint: hint(organization.iban),
      walletId: organization.walletId,
      splitConfigured: organization.paycometSplitId !== null,
      kybStatus: organization.kybStatus,
      kybSubmittedAt: organization.kybSubmittedAt?.toISOString() ?? null,
      kybReviewedAt: organization.kybReviewedAt?.toISOString() ?? null,
      kybReviewNote: organization.kybReviewNote,
      ley49: organization.ley49,
      ley49VerifiedAt: organization.ley49VerifiedAt?.toISOString() ?? null,
      medalRank: organization.medalRank,
      completedThisYear: organization.completedThisYear,
      completedHistorical: organization.completedHistorical,
      activeSponsorsCount: organization.activeSponsorsCount,
      historicalSponsorsCount: organization.historicalSponsorsCount,
      archived: organization.archivedAt !== null,
      signatureMode: organization.signatureMode
    },
    documents: documents.map((document) => ({ id: document.id, kind: document.kind, createdAt: document.createdAt.toISOString() })),
    readiness: kybReadiness({ ley49: organization.ley49, cif: organization.cif, currentKinds: documents.map((document) => document.kind) }),
    seats: members.map((member) => ({ id: member.id, role: member.role as 'DIRECTOR' | 'COSIGNER', roleLabel: member.roleLabel, name: member.user.name, maskedEmail: maskEmail(member.user.email), twoFactor: member.user.twoFactorEnabled, since: member.createdAt.toISOString() })),
    handover: handover ? { id: handover.id, role: handover.role as 'DIRECTOR' | 'COSIGNER', expiresAt: handover.expiresAt.toISOString(), expired: handover.expiresAt <= now } : null,
    customRules: organization.customRules,
    tariffs: pickTariffValues(organization),
    globalTariffs: pickTariffValues(globalConfig),
    categories: [...byName.values()],
    invoices: invoices.map((invoice) => ({ ...invoice, issuedAt: invoice.issuedAt.toISOString() })),
    business
  };
}

export interface OrgListRow {
  id: string;
  slug: string;
  name: string;
  province: string;
  vertical: string;
  kybStatus: 'PENDING' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED';
  kybSubmittedAt: string | null;
  medalRank: number;
  archived: boolean;
}

/** Entidades para elegir ficha: las que esperan revisión primero y, entre ellas, la que lleva más tiempo esperando. */
export async function listOrganizationsForConsole(db: Db): Promise<OrgListRow[]> {
  const rows = await db.organization.findMany({ orderBy: [{ name: 'asc' }], select: { id: true, slug: true, name: true, province: true, vertical: true, kybStatus: true, kybSubmittedAt: true, medalRank: true, archivedAt: true } });
  return rows.map((row) => ({ ...row, kybSubmittedAt: row.kybSubmittedAt?.toISOString() ?? null, archived: row.archivedAt !== null }));
}
