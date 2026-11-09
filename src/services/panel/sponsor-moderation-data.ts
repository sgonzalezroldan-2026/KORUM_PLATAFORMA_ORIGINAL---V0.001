import { bpsOf } from '@/core/finance/money';
import { needsDecision, sortForModeration, type SponsorModerationStatus } from '@/core/sponsors/sponsor-moderation-rules';
import { SPONSOR_FEE_VAT_BPS, type SponsorLevel } from '@/core/sponsors/sponsorship-rules';
import type { KorumPrismaClient } from '@/lib/prisma';
import { listModerationSponsors, type ModerationSponsorRow } from '@/repositories/sponsor-moderation.repository';
import type { SessionActor } from '@/repositories/tenant-guard';
import { publicLogoSrc } from '@/services/portal/achievements-data';

/**
 * Comercios de la bandeja de aprobaciones (Sprint 4.2b) ya preparados para la vista: fechas en ISO, importes en céntimos y el logotipo solo si es
 * público. Lo que se devolvería al rechazar sale de lo cobrado (`totalChargedCents`), que es exactamente lo que vuelve al comercio.
 */

export interface ModerationSponsorView {
  id: number;
  name: string;
  sector: string;
  level: SponsorLevel;
  status: SponsorModerationStatus;
  needsDecision: boolean;
  amountCents: number;
  feeCents: number;
  vatCents: number;
  refundCents: number;
  matching: boolean;
  promo: string;
  code: string;
  contactPerson: string;
  phone: string;
  email: string;
  autoRenew: boolean;
  paidAt: string | null;
  expiresAt: string;
  logoSrc: string | null;
  initiative: { id: number; title: string; walletEscrowId: string; status: string } | null;
}

function view(row: ModerationSponsorRow): ModerationSponsorView {
  const status = row.status as SponsorModerationStatus;
  // De un comercio ya cerrado (no admitido o devuelto) la entidad no necesita el contacto: no se envía al navegador (minimización).
  const closed = status === 'REJECTED' || status === 'REFUNDED';
  return {
    id: row.id,
    name: row.name,
    sector: row.sector,
    level: row.categoryLevel as SponsorLevel,
    status,
    // Un comercio cuyo cobro se devolvió por otra vía (contracargo) ya no pide decisión aunque siga `PENDING`.
    needsDecision: needsDecision(row) && row.contribution?.status === 'COMPLETED',
    amountCents: row.amountCents,
    feeCents: row.feeGeneratedCents,
    vatCents: bpsOf(row.feeGeneratedCents, SPONSOR_FEE_VAT_BPS),
    refundCents: row.contribution?.totalChargedCents ?? 0,
    matching: row.isMatchingPool,
    promo: row.promo,
    code: row.code,
    contactPerson: closed ? '' : row.contactPerson,
    phone: closed ? '' : row.phone,
    email: closed ? '' : row.email,
    autoRenew: row.autoRenew,
    paidAt: row.paidAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    logoSrc: publicLogoSrc(row.logoFile),
    initiative: row.initiative
  };
}

export async function loadSponsorModeration(db: KorumPrismaClient, actor: SessionActor, organizationId: string): Promise<{ open: ModerationSponsorView[]; closed: ModerationSponsorView[] }> {
  const { open, closed } = await listModerationSponsors(db, actor, organizationId);
  return { open: sortForModeration(open.map(view)), closed: closed.map(view) };
}
