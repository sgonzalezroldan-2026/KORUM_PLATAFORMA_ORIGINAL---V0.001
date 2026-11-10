import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { CLOSED_SPONSORS_SHOWN } from '@/core/sponsors/sponsor-moderation-rules';
import { DEFAULT_CREDIT_POOL_MAX_DAYS } from '@/core/sponsors/sponsor-reassignment-rules';
import type { Prisma } from '@/generated/prisma/client';
import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeTenant, type SessionActor } from './tenant-guard';

/**
 * Lecturas de los comercios amigos en la bandeja de aprobaciones (Sprint 4.2b, `id="sch-sponsors-moderation-list"`). Autoriza primero
 * (`DIRECTOR` o `COSIGNER` de **esa** entidad; el Super-Admin entra con registro y en solo lectura) y elige cada campo. La entidad ve el contacto del
 * comercio que la patrocina (como en el prototipo), su nivel y su fee; **nunca** su CIF cifrado. Solo comercios **cobrados**: un pago que no se
 * completó no pide ninguna decisión y se purga a los 30 días.
 */

const SPONSOR_VIEW = {
  id: true,
  name: true,
  sector: true,
  categoryLevel: true,
  amountCents: true,
  feeGeneratedCents: true,
  isMatchingPool: true,
  promo: true,
  code: true,
  contactPerson: true,
  phone: true,
  email: true,
  autoRenew: true,
  paidAt: true,
  expiresAt: true,
  status: true,
  logoFile: { select: { id: true, visibility: true, deletedAt: true } },
  initiative: { select: { id: true, title: true, walletEscrowId: true, status: true } },
  contribution: { select: { status: true, totalChargedCents: true, createdAt: true } },
  // Renovación y reasignación (Sprint 4.2d): dónde está su dinero ahora y si ya ha renovado.
  reassignedCents: true,
  creditPoolAt: true,
  renewedFromId: true,
  allocations: { where: { withdrawnAt: null }, orderBy: { id: 'asc' }, select: { amountCents: true, initiative: { select: { id: true, title: true, walletEscrowId: true } } } },
  renewals: { where: { paidAt: { not: null } }, select: { id: true }, take: 1 }
} satisfies Prisma.SponsorSelect;

export async function listModerationSponsors(db: KorumPrismaClient, actor: SessionActor, organizationId: string) {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'sponsor.moderation_list', targetType: 'Organization' });
  const [open, closed] = await Promise.all([
    db.sponsor.findMany({ where: { organizationId, paidAt: { not: null }, status: { in: ['PENDING', 'APPROVED', 'CREDIT_POOL'] } }, orderBy: { id: 'asc' }, select: SPONSOR_VIEW }),
    db.sponsor.findMany({ where: { organizationId, paidAt: { not: null }, status: { in: ['REJECTED', 'REFUNDED'] } }, orderBy: { id: 'desc' }, take: CLOSED_SPONSORS_SHOWN, select: SPONSOR_VIEW })
  ]);
  return { open, closed };
}

/**
 * Lo que necesita la renovación y la reasignación en la bandeja (Sprint 4.2d): la regla de la entidad, el plazo máximo de la bolsa, lo que cada comercio
 * tiene en ella (según el libro) y las campañas a las que el centro puede llevarlo. Mismo permiso que la bandeja.
 */
export async function loadSponsorRenewalContext(db: KorumPrismaClient, actor: SessionActor, organizationId: string, now: Date) {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'sponsor.moderation_list', targetType: 'Organization' });
  const [organization, config, pools, targets] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { sponsorRenewalRule: true } }),
    db.globalConfig.findUnique({ where: { id: 'GLOBAL' }, select: { creditPoolMaxDays: true } }),
    db.escrowLedgerEntry.groupBy({ by: ['sponsorId', 'direction'], where: { account: 'SPONSOR_CREDIT_POOL', organizationId }, _sum: { amountCents: true } }),
    db.initiative.findMany({ where: { organizationId, status: 'FUNDRAISING', format: 'BUDGET', closesAt: { gt: now } }, orderBy: [{ closesAt: 'asc' }, { id: 'asc' }], select: { id: true, title: true, closesAt: true } })
  ]);
  const poolCents = new Map<number, number>();
  for (const row of pools) {
    if (row.sponsorId === null) continue;
    const amount = row._sum.amountCents ?? 0;
    poolCents.set(row.sponsorId, (poolCents.get(row.sponsorId) ?? 0) + (row.direction === 'CREDIT' ? amount : -amount));
  }
  return { rule: organization.sponsorRenewalRule, creditPoolMaxDays: config?.creditPoolMaxDays ?? DEFAULT_CREDIT_POOL_MAX_DAYS, poolCents, targets };
}

export type ModerationSponsorRow = Awaited<ReturnType<typeof listModerationSponsors>>['open'][number];

/**
 * Cuántas decisiones esperan en «Aprobaciones»: comercios cobrados sin revisar, propuestas de idea nuevas e ideas en la doble firma. Es el contador de la
 * pestaña del panel (revisión de experiencia del 4.2a). Mismo permiso que la bandeja: quien no puede verla no ve tampoco el número.
 */
export async function countPendingApprovals(db: KorumPrismaClient, actor: SessionActor, organizationId: string): Promise<number> {
  // El Super-Admin no decide por la entidad: sin contador, y sin una fila de auditoría más en cada página del panel que abre.
  if (actor.kind === 'user' && actor.isSuperadmin) return 0;
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'approvals.count', targetType: 'Organization' });
  const [sponsors, ideas] = await Promise.all([
    db.sponsor.count({ where: { organizationId, status: 'PENDING', paidAt: { not: null }, contribution: { status: 'COMPLETED' } } }),
    db.idea.count({ where: { organizationId, phase: { in: ['PHASE0_MOD', 'DOUBLE_CHECK'] } } })
  ]);
  return sponsors + ideas;
}
