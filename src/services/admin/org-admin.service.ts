import { assertVerifiedSuperadmin, revalidateActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { categoryRuleSchema, categorySchema, invalidTariffFields, pickTariffValues, shiftedExemptRemaining, tariffSchema } from '@/core/admin/org-360-rules';
import { inTransaction, isUniqueViolation, type Db } from '@/lib/db';

/**
 * Acciones de la ficha 360º sobre una entidad (Sprint 5.2): sus tarifas propias y sus categorías. Quién firma por la entidad lo regula ella misma (decisión del promotor, 2026-11-12): el Super-Admin no da de baja ni confirma puestos.
 * Todas exigen el Super-Admin verificado (TOTP de hace menos de 10 minutos), bloquean primero la fila de la entidad (dos personas a la vez se ordenan)
 * y dejan en la auditoría el antes y el después, sin datos personales.
 */

export type OrgAdminRejection = 'NOT_FOUND' | 'ARCHIVED' | 'INVALID' | 'PUBLISHED_TICKETING' | 'LIMIT_BELOW_USED' | 'CATEGORY_EXISTS' | 'CATEGORY_NOT_FOUND';

export class OrgAdminRejectedError extends Error {
  constructor(
    readonly reason: OrgAdminRejection,
    readonly fields: string[] = []
  ) {
    super(`No se puede completar la operación sobre la entidad: ${reason}.`);
    this.name = 'OrgAdminRejectedError';
  }
}

/**
 * ¿Tiene la entidad una taquilla o rifa a la venta? Cuenta las que recaudan y también las que ya cumplieron la meta pero aún no han cerrado (un contracargo las
 * reabre y volverían a vender con la tarifa nueva): la compra de entradas lee la tarifa actual de la entidad, no la de la publicación (auditoría financiera, M2).
 */
export async function hasTicketingOnSale(db: Db, organizationId: string, now: Date): Promise<boolean> {
  return (await db.initiative.count({ where: { organizationId, format: 'TICKETING', status: { in: ['FUNDRAISING', 'GOAL_REACHED'] }, closesAt: { gt: now } } })) > 0;
}

/** Bloquea la fila de la entidad y la devuelve; una entidad archivada no se toca (su ficha es solo de lectura). */
async function lockOrganization(tx: Db, organizationId: string, now: Date) {
  const { count } = await tx.organization.updateMany({ where: { id: organizationId, archivedAt: null }, data: { updatedAt: now } });
  if (count === 1) return;
  const exists = await tx.organization.findUnique({ where: { id: organizationId }, select: { archivedAt: true } });
  throw new OrgAdminRejectedError(exists ? 'ARCHIVED' : 'NOT_FOUND');
}

const audit = (tx: Db, actor: VerifiedSuperadminActor, organizationId: string, action: string, targetType: string, targetId: string, metadata: Record<string, unknown>) =>
  tx.auditLog.create({ data: { actorType: 'USER', actorUserId: actor.userId, organizationId, action, targetType, targetId, metadataJson: metadata as never } });

/**
 * Tarifas propias de la entidad. Con `customRules` encendido se guardan sus once campos (enteros: céntimos y puntos básicos; Zod rechaza lo imposible);
 * apagado, la entidad vuelve a las globales y sus campos se igualan a ellas, porque el Estudio lee los de la entidad. Cambiar el límite exento mueve el
 * cupo restante lo mismo, de modo que lo ya gastado en el curso no cambia. **Solo afecta a campañas futuras**: las ya calculadas conservan su pizarra.
 */
export async function saveOrganizationTariffs(db: Db, actor: VerifiedSuperadminActor, organizationId: string, raw: unknown, now: Date = new Date()): Promise<void> {
  assertVerifiedSuperadmin(actor, 'organization.tariffs_update', now);
  const parsed = tariffSchema.safeParse(raw);
  if (!parsed.success) throw new OrgAdminRejectedError('INVALID', invalidTariffFields(parsed.error));
  const input = parsed.data;
  await inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'organization.tariffs_update', now);
    await lockOrganization(tx, organizationId, now);
    const [before, global] = await Promise.all([
      tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { customRules: true, exemptLimitCents: true, exemptRemainingCents: true, t1Bps: true, t2Bps: true, t3Bps: true, sponsorFeeBps: true, fullIntegrityCheckCents: true, ticketFeeFixedCents: true, ticketFeeBps: true, maintActive: true, maintPerInitCents: true, maintAnnualCapCents: true } }),
      tx.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' } })
    ]);
    const values = pickTariffValues(input.customRules ? input : global);
    // La compra de entradas lee la tarifa actual de la entidad: con una taquilla o rifa a la venta no se cambian sus gastos de gestión (cambiaría lo prometido).
    if ((values.ticketFeeFixedCents !== before.ticketFeeFixedCents || values.ticketFeeBps !== before.ticketFeeBps) && (await hasTicketingOnSale(tx, organizationId, now))) {
      throw new OrgAdminRejectedError('PUBLISHED_TICKETING', ['ticketFeeFixedCents', 'ticketFeeBps']);
    }
    const exemptRemainingCents = shiftedExemptRemaining(before.exemptLimitCents, values.exemptLimitCents, before.exemptRemainingCents);
    // Un límite propio por debajo de lo ya gastado se rechaza al editarlo. Al **volver a los globales** se acepta aunque el global sea menor que lo gastado (la
    // entidad ya no puede quedarse atrapada): el cupo restante queda a 0 y no se crea cupo nuevo.
    if (exemptRemainingCents === null && input.customRules) throw new OrgAdminRejectedError('LIMIT_BELOW_USED', ['exemptLimitCents']);
    const data = { ...values, customRules: input.customRules, exemptRemainingCents: exemptRemainingCents ?? 0 };
    await tx.organization.update({ where: { id: organizationId }, data });
    await audit(tx, actor, organizationId, 'organization.tariffs_updated', 'Organization', organizationId, { before, after: data });
  });
}

/** Categoría que se pasa a exenta (0 %) o a por tramos para esta entidad. Una global se «sobrescribe» con una fila propia del mismo nombre. */
export async function setOrganizationCategoryRule(db: Db, actor: VerifiedSuperadminActor, organizationId: string, raw: unknown, now: Date = new Date()): Promise<void> {
  assertVerifiedSuperadmin(actor, 'organization.category_rule', now);
  const parsed = categoryRuleSchema.safeParse(raw);
  if (!parsed.success) throw new OrgAdminRejectedError('INVALID', ['name']);
  const { name, rule } = parsed.data;
  await inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'organization.category_rule', now);
    await lockOrganization(tx, organizationId, now);
    const own = await tx.organizationCategory.findUnique({ where: { organizationId_name: { organizationId, name } }, select: { id: true, rule: true } });
    if (own) {
      await tx.organizationCategory.update({ where: { id: own.id }, data: { rule } });
    } else {
      const global = await tx.globalCategory.findUnique({ where: { name }, select: { icon: true } });
      if (!global) throw new OrgAdminRejectedError('CATEGORY_NOT_FOUND', ['name']);
      await tx.organizationCategory.create({ data: { organizationId, name, icon: global.icon, rule, isCustom: false } });
    }
    await audit(tx, actor, organizationId, 'organization.category_rule_set', 'Organization', organizationId, { name, rule, before: own?.rule ?? null });
  });
}

/** Categoría propia nueva de la entidad (el nombre no puede repetir una suya ni una global: para cambiar una global se usa su regla). */
export async function addOrganizationCategory(db: Db, actor: VerifiedSuperadminActor, organizationId: string, raw: unknown, now: Date = new Date()): Promise<void> {
  assertVerifiedSuperadmin(actor, 'organization.category_add', now);
  const parsed = categorySchema.safeParse(raw);
  if (!parsed.success) throw new OrgAdminRejectedError('INVALID', [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'form')))]);
  const { name, icon, rule } = parsed.data;
  try {
    await inTransaction(db, async (tx) => {
      await revalidateActor(tx, actor, 'organization.category_add', now);
      await lockOrganization(tx, organizationId, now);
      if (await tx.globalCategory.findUnique({ where: { name }, select: { id: true } })) throw new OrgAdminRejectedError('CATEGORY_EXISTS', ['name']);
      await tx.organizationCategory.create({ data: { organizationId, name, icon, rule, isCustom: true } });
      await audit(tx, actor, organizationId, 'organization.category_added', 'Organization', organizationId, { name, rule });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new OrgAdminRejectedError('CATEGORY_EXISTS', ['name']);
    throw error;
  }
}
