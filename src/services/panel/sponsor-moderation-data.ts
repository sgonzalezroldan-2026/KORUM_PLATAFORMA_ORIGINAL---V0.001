import { bpsOf } from '@/core/finance/money';
import { needsDecision, sortForModeration, type SponsorModerationStatus } from '@/core/sponsors/sponsor-moderation-rules';
import { creditPoolDeadline, isEligibleTarget, RENEWAL_LINK_DAYS, renewalWindowOpen, type SponsorRenewalRule } from '@/core/sponsors/sponsor-reassignment-rules';
import { SPONSOR_FEE_VAT_BPS, type SponsorLevel } from '@/core/sponsors/sponsorship-rules';
import type { KorumPrismaClient } from '@/lib/prisma';
import { listModerationSponsors, loadSponsorRenewalContext, type ModerationSponsorRow } from '@/repositories/sponsor-moderation.repository';
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
  /** Dónde está ahora su dinero (Sprint 4.2d): lo que sigue en su campaña de origen, lo llevado a otras y lo que espera en la bolsa (y hasta cuándo). */
  money: {
    originCents: number;
    placed: Array<{ initiativeId: number; title: string; walletEscrowId: string; amountCents: number }>;
    poolCents: number;
    poolDeadline: string | null;
  };
  /** Es la renovación de un año anterior. */
  isRenewal: boolean;
  /** Ya ha pagado la renovación del año siguiente. */
  renewed: boolean;
  /** Se le puede (re)enviar el enlace de pago de la renovación hoy. */
  renewalOpen: boolean;
  /** Renueva cada año pero aún es pronto: desde cuándo se le podrá enviar el enlace (30 días antes de que caduque). */
  renewalOpensAt: string | null;
  /** Campañas a las que el centro puede llevar lo que espera en la bolsa (dentro de la ventana de su cobro), con su cierre. */
  assignable: Array<{ id: number; title: string; closesAt: string }>;
}

type RenewalContext = Awaited<ReturnType<typeof loadSponsorRenewalContext>>;

function view(row: ModerationSponsorRow, context: RenewalContext, now: Date): ModerationSponsorView {
  const renewable = (row.status === 'APPROVED' || row.status === 'CREDIT_POOL') && row.autoRenew && row.paidAt !== null && row.renewals.length === 0;
  const opensAt = new Date(row.expiresAt.getTime() - RENEWAL_LINK_DAYS * 86_400_000);
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
    initiative: row.initiative,
    money: moneyOf(row, context),
    isRenewal: row.renewedFromId !== null,
    renewed: row.renewals.length > 0,
    renewalOpen: renewable && renewalWindowOpen(row.expiresAt, now),
    renewalOpensAt: renewable && now.getTime() < opensAt.getTime() ? opensAt.toISOString() : null,
    assignable:
      status === 'CREDIT_POOL' && row.contribution
        ? context.targets.filter((target) => isEligibleTarget(target, row.contribution?.createdAt ?? now, now)).map((target) => ({ id: target.id, title: target.title, closesAt: target.closesAt.toISOString() }))
        : []
  };
}

function moneyOf(row: ModerationSponsorRow, context: RenewalContext): ModerationSponsorView['money'] {
  const poolCents = Math.max(0, context.poolCents.get(row.id) ?? 0);
  const failedOrigin = row.initiative !== null && ['REFUNDING', 'CANCELLED', 'REFUNDED'].includes(row.initiative.status);
  return {
    originCents: row.renewedFromId === null && !failedOrigin ? row.amountCents - row.reassignedCents : 0,
    placed: row.allocations.map((allocation) => ({ initiativeId: allocation.initiative.id, title: allocation.initiative.title, walletEscrowId: allocation.initiative.walletEscrowId, amountCents: allocation.amountCents })),
    poolCents,
    poolDeadline: row.creditPoolAt && row.contribution ? creditPoolDeadline({ paidAt: row.contribution.createdAt, creditPoolAt: row.creditPoolAt }, context.creditPoolMaxDays).toISOString() : null
  };
}

export async function loadSponsorModeration(
  db: KorumPrismaClient,
  actor: SessionActor,
  organizationId: string,
  now: Date = new Date()
): Promise<{ open: ModerationSponsorView[]; closed: ModerationSponsorView[]; rule: SponsorRenewalRule; creditPoolMaxDays: number }> {
  const [{ open, closed }, context] = await Promise.all([listModerationSponsors(db, actor, organizationId), loadSponsorRenewalContext(db, actor, organizationId, now)]);
  const toView = (row: ModerationSponsorRow) => view(row, context, now);
  return { open: sortForModeration(open.map(toView)), closed: closed.map(toView), rule: context.rule, creditPoolMaxDays: context.creditPoolMaxDays };
}
