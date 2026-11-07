import { canIssueTaxCertificate, PENDING_CONFIRMATION_MS } from '@/core/checkout/checkout-rules';
import type { Db } from '@/lib/db';
import { openPledgeCampaigns } from '@/services/pledges/pledge.service';

/**
 * Lecturas de Mi Hucha (`/mi-hucha`, Sprint 3.8). Todas reciben el `userId` **de la sesión** y nunca uno del navegador: una aportación mensual de
 * otra persona no existe para esta. Ninguna devuelve el token de la tarjeta ni el NIF: de la tarjeta solo la marca y los 4 últimos dígitos (si
 * Paycomet los dio), y de la entidad, lo público.
 */

/** Altas que nunca llegaron a empezar (sustituidas o con el primer pago fallido): no se enseñan, no hay nada que gestionar. */
const NEVER_STARTED = ['REPLACED', 'FIRST_PAYMENT_FAILED'] as const;

export async function loadUserPledges(db: Db, userId: string, now: Date) {
  const pledges = await db.walletSubscription.findMany({
    where: {
      userId,
      organizationId: { not: null },
      OR: [
        { status: { in: ['ACTIVE', 'PAUSED', 'FINISHED'] } },
        { status: 'CANCELLED', NOT: { statusReason: { in: [...NEVER_STARTED] } } },
        // Esperando la confirmación del primer pago: solo mientras es reciente (después se da por no completado).
        { status: 'PENDING', createdAt: { gt: new Date(now.getTime() - PENDING_CONFIRMATION_MS) } }
      ]
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 50,
    select: {
      id: true,
      status: true,
      statusReason: true,
      monthlyAmountCents: true,
      feePerMonthCents: true,
      totalMonths: true,
      executedMonths: true,
      skippedMonths: true,
      nextChargeAt: true,
      initiativeId: true,
      createdAt: true,
      organization: { select: { name: true, slug: true, initiatives: { where: openPledgeCampaigns(now), orderBy: { closesAt: 'asc' }, select: { id: true, title: true } } } },
      paymentMethodToken: { select: { brand: true, last4: true, revokedAt: true } },
      contributions: { orderBy: { pledgeCycle: 'asc' }, select: { pledgeCycle: true, status: true, amountCents: true, createdAt: true, initiative: { select: { title: true } } } }
    }
  });
  const rank = (status: string) => (status === 'ACTIVE' || status === 'PAUSED' || status === 'PENDING' ? 0 : 1);
  return pledges
    .map((pledge) => ({
      ...pledge,
      organization: pledge.organization ?? { name: '', slug: '', initiatives: [] },
      // Solo lo que de verdad ha llegado a la campaña: sin meses fallidos, devueltos ni pendientes.
      contributedCents: pledge.contributions.filter((row) => row.status === 'COMPLETED').reduce((total, row) => total + row.amountCents, 0)
    }))
    .sort((a, b) => rank(a.status) - rank(b.status));
}

export type UserPledge = Awaited<ReturnType<typeof loadUserPledges>>[number];

/** Lo que necesita el formulario de alta para una entidad: sus campañas recaudando, si emite certificado fiscal y la gestión por cargo. */
export async function loadPledgeOffer(db: Db, orgSlug: string, now: Date) {
  const [organization, rules] = await Promise.all([
    db.organization.findFirst({
      where: { slug: orgSlug, archivedAt: null },
      select: { name: true, slug: true, ley49: true, ley49VerifiedAt: true, initiatives: { where: openPledgeCampaigns(now), orderBy: { closesAt: 'asc' }, select: { id: true, title: true, closesAt: true } } }
    }),
    db.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' }, select: { topupFeeCents: true, topupFeeBps: true } })
  ]);
  if (!organization) return null;
  return {
    name: organization.name,
    slug: organization.slug,
    certificate: canIssueTaxCertificate(organization),
    campaigns: organization.initiatives.map((campaign) => ({ id: campaign.id, title: campaign.title, closesAt: campaign.closesAt.toISOString() })),
    feeRules: rules
  };
}

export type PledgeOffer = NonNullable<Awaited<ReturnType<typeof loadPledgeOffer>>>;

/** Vuelta del primer pago (`?pedido=`): solo si el pedido es de esta persona y de una aportación mensual. */
export async function loadPledgeResult(db: Db, userId: string, order: string) {
  return db.contribution.findFirst({
    where: { paycometOrder: order, userId, walletSubscriptionId: { not: null }, pledgeCycle: 1 },
    select: { status: true, createdAt: true, organization: { select: { name: true } }, walletSubscription: { select: { status: true, statusReason: true } } }
  });
}

/** Entidades a las que la persona ya ha aportado: atajo para programar la aportación mensual sin volver a buscarlas. */
export async function loadSuggestedOrganizations(db: Db, userId: string) {
  return db.organization.findMany({ where: { archivedAt: null, contributions: { some: { userId } } }, orderBy: { name: 'asc' }, take: 10, select: { name: true, slug: true } });
}
