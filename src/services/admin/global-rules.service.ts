import { categoryRuleSchema, categorySchema, reviewNote } from '@/core/admin/org-360-rules';
import {
  changedRuleKeys,
  changesTicketFee,
  globalRulesSchema,
  invalidRuleFields,
  MAX_ACKNOWLEDGEMENTS,
  medalsSchema,
  pricingAcknowledgeTarget,
  type GlobalRulesInput,
  type MedalsInput
} from '@/core/admin/global-rules';
import { assertVerifiedSuperadmin, revalidateActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { inTransaction, isUniqueViolation, type Db } from '@/lib/db';
import { coarseUserAgent, type RequestMeta } from '@/repositories/tenant-guard';
import { writeAudit } from '@/services/audit/audit.service';
import { SETTING_DEFINITIONS } from '@/services/settings/setting-definitions';
import { invalidateSettingsCache } from '@/services/settings/settings.service';
import { loadPricingHealth } from './pricing-health-data';

/**
 * Motor de reglas globales de la consola (Sprint 5.3, prototipo `sa-sub-rules`): tramos, fee de Mi Hucha, pasarela, gastos de gestión digital,
 * aportación de garantía, mantenimiento, duración de las campañas, medallas y categorías globales, más «Aceptar y registrar» un aviso de precios.
 *
 * - Todo exige el Super-Admin verificado (TOTP de hace menos de 10 minutos) y se escribe en una transacción con su auditoría (qué cambió, de qué a qué).
 * - **Ninguna regla de precios se bloquea por «perder dinero»** (la salud de precios avisa); sí se rechazan los datos imposibles (esquema Zod).
 * - **Guardar es con bloqueo optimista por valores**: el formulario manda las reglas que tenía delante (`version`) y, si otra persona las cambió antes, no se pisa (`STALE`). Se compara
 *   por valores y no por fecha porque la numeración de facturas también toca `GlobalConfig.updatedAt` y daría falsos «otra persona guardó antes» (auditoría financiera del 5.3, M1).
 * - **Las filas se bloquean antes de leer** (la global y las entidades sin tarifa propia): una reserva de cupos o una publicación a la vez se ordena con el guardado y nunca
 *   lee un valor viejo (auditoría financiera del 5.3, I2 y M3).
 * - **Una entidad guarda una copia de sus tarifas.** Las entidades sin tarifa propia (`customRules = false`) las igualan a las globales en la misma transacción,
 *   para que el Estudio, la compra de entradas y el BI lean lo mismo; las de tarifa propia no se tocan. Solo cambia lo que se calcula **desde ese momento**: una campaña
 *   ya publicada conserva su pizarra.
 */

export type GlobalRulesRejection = 'INVALID' | 'STALE' | 'TICKETING_ON_SALE' | 'CREDIT_POOL_OPEN' | 'CATEGORY_EXISTS' | 'CATEGORY_NOT_FOUND' | 'ALERT_CHANGED' | 'ALERT_NOT_FOUND';

export class GlobalRulesRejectedError extends Error {
  constructor(
    readonly reason: GlobalRulesRejection,
    readonly fields: string[] = []
  ) {
    super(`No se pueden guardar las reglas globales: ${reason}.`);
    this.name = 'GlobalRulesRejectedError';
  }
}

const RULE_COLUMNS = [
  'exemptLimitCents',
  'bracketMode',
  't1MaxCents',
  't2MaxCents',
  't1Bps',
  't2Bps',
  't3Bps',
  'sponsorFeeBps',
  'fullIntegrityCheckCents',
  'guaranteePresetsCents',
  'defaultGuaranteeIdx',
  'gatewayPctBps',
  'gatewayFixedCents',
  'topupFeeCents',
  'topupFeeBps',
  'ticketFeeFixedCents',
  'ticketFeeBps',
  'maintActive',
  'maintPerInitCents',
  'maintAnnualCapCents',
  'maxCampaignDays',
  'creditPoolMaxDays'
] as const satisfies ReadonlyArray<keyof GlobalRulesInput>;

export interface GlobalRulesView {
  rules: GlobalRulesInput;
  /** Versión de lo que se ve en pantalla (las reglas, en un texto estable): el formulario la devuelve al guardar (bloqueo optimista por valores). */
  version: string;
}

/** Texto estable de las reglas, en el orden fijo de `RULE_COLUMNS`: dos configuraciones con los mismos valores tienen la misma versión. */
export const rulesVersionOf = (rules: GlobalRulesInput): string => JSON.stringify(RULE_COLUMNS.map((key) => rules[key]));

export async function loadGlobalRulesView(db: Db): Promise<GlobalRulesView> {
  const row = await db.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' } });
  const rules = Object.fromEntries(RULE_COLUMNS.map((key) => [key, row[key]])) as unknown as GlobalRulesInput;
  return { rules, version: rulesVersionOf(rules) };
}

/** Quién y desde dónde (HMAC de la IP y familia de navegador), para las operaciones que cambian precios o salen con el nombre de la plataforma. */
export const auditWho = (actor: VerifiedSuperadminActor, meta?: RequestMeta) => ({ actorType: 'USER' as const, actorUserId: actor.userId, ipHash: meta?.ipHash ?? null, userAgent: coarseUserAgent(meta?.userAgent) });

/** Lo que se audita de un cambio: solo los campos que cambian, con su antes y su después (cifras, nunca datos personales). */
function changesOf(before: GlobalRulesInput, after: GlobalRulesInput): Record<string, { from: unknown; to: unknown }> {
  return Object.fromEntries(changedRuleKeys(before, after).map((key) => [key, { from: before[key], to: after[key] }]));
}

/** Campos de las reglas que cada entidad guarda como copia de sus tarifas (Regla 01: el Estudio lee los de la entidad). */
function tariffCopyOf(rules: GlobalRulesInput) {
  return {
    t1Bps: rules.t1Bps,
    t2Bps: rules.t2Bps,
    t3Bps: rules.t3Bps,
    sponsorFeeBps: rules.sponsorFeeBps,
    fullIntegrityCheckCents: rules.fullIntegrityCheckCents,
    ticketFeeFixedCents: rules.ticketFeeFixedCents,
    ticketFeeBps: rules.ticketFeeBps,
    maintActive: rules.maintActive,
    maintPerInitCents: rules.maintPerInitCents,
    maintAnnualCapCents: rules.maintAnnualCapCents
  };
}

/**
 * Guarda las reglas globales y las propaga a las entidades sin tarifa propia. El límite exento mueve el cupo restante lo mismo (lo ya gastado no cambia; si el
 * límite nuevo no cubre lo gastado, la entidad conserva un límite igual a lo gastado y el cupo restante queda a 0). Con una taquilla o rifa a la venta en una de esas
 * entidades **no se pueden cambiar los gastos de gestión digital** (la compra de entradas lee la tarifa actual y cambiaría lo prometido y la meta), y con un comercio en la
 * bolsa **no se puede cambiar la duración de las bolsas** (cambiaría la fecha que ya se le comunicó). Cualquiera de los dos rechaza el guardado entero.
 */
export async function saveGlobalRules(db: Db, actor: VerifiedSuperadminActor, raw: unknown, expectedVersion: string, now: Date = new Date(), meta?: RequestMeta): Promise<{ changed: number; organizationsUpdated: number }> {
  assertVerifiedSuperadmin(actor, 'rules.global_update', now);
  const parsed = globalRulesSchema.safeParse(raw);
  if (!parsed.success) throw new GlobalRulesRejectedError('INVALID', invalidRuleFields(parsed.error));
  const next = parsed.data;
  return inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'rules.global_update', now);
    // Primero se bloquea la fila global (con una escritura, como hace la numeración de facturas) y solo después se lee: dos guardados a la vez se ordenan.
    await tx.globalConfig.updateMany({ where: { id: 'GLOBAL' }, data: { updatedAt: now } });
    const row = await tx.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' } });
    const before = Object.fromEntries(RULE_COLUMNS.map((key) => [key, row[key]])) as unknown as GlobalRulesInput;
    if (rulesVersionOf(before) !== expectedVersion) throw new GlobalRulesRejectedError('STALE');
    const changes = changesOf(before, next);
    const changed = Object.keys(changes).length;
    if (changed === 0) return { changed: 0, organizationsUpdated: 0 };

    // Después se bloquean las entidades sin tarifa propia: una reserva de cupos o una publicación de una de ellas a la vez espera a este guardado (o este a ella) y las
    // lecturas de abajo ya ven lo que ellas confirmaron.
    const eligible = { customRules: false, archivedAt: null };
    await tx.organization.updateMany({ where: eligible, data: { updatedAt: now } });

    if (changesTicketFee(before, next)) {
      const onSale = await tx.initiative.count({
        where: { format: 'TICKETING', status: { in: ['FUNDRAISING', 'GOAL_REACHED'] }, closesAt: { gt: now }, organization: eligible }
      });
      if (onSale > 0) throw new GlobalRulesRejectedError('TICKETING_ON_SALE', ['ticketFeeFixedCents', 'ticketFeeBps']);
    }
    if (before.creditPoolMaxDays !== next.creditPoolMaxDays && (await tx.sponsor.count({ where: { creditPoolAt: { not: null } } })) > 0) {
      throw new GlobalRulesRejectedError('CREDIT_POOL_OPEN', ['creditPoolMaxDays']);
    }

    await tx.globalConfig.update({ where: { id: 'GLOBAL' }, data: next });

    // Las entidades sin tarifa propia igualan sus copias a las globales. Las de tarifa propia no se tocan.
    const sameCopy = changedRuleKeys(before, next).some((key) => key in tariffCopyOf(next));
    const exemptChanged = before.exemptLimitCents !== next.exemptLimitCents;
    let organizationsUpdated = 0;
    if (sameCopy) organizationsUpdated = (await tx.organization.updateMany({ where: eligible, data: { ...tariffCopyOf(next), updatedAt: now } })).count;
    if (exemptChanged) {
      // Lo gastado en el curso no cambia: cupo restante = límite nuevo − gastado. Si el límite nuevo no cubre lo gastado por una entidad, esa entidad se queda con un
      // límite igual a lo gastado y el cupo restante a 0: así no se pierde lo gastado y, si el límite global vuelve a subir, el cupo reaparece exacto (nunca se crea
      // cupo de la nada, a diferencia de recortar el límite a lo nuevo). Las filas están bloqueadas desde arriba: ninguna reserva cambia entre la lectura y la escritura.
      // Se agrupan por su resultado: una consulta por cada combinación, no una por entidad. La renovación del curso usa el límite global, no esta copia.
      const organizations = await tx.organization.findMany({ where: eligible, select: { id: true, exemptLimitCents: true, exemptRemainingCents: true } });
      const groups = new Map<string, { limitCents: number; remainingCents: number; ids: string[] }>();
      for (const organization of organizations) {
        const usedCents = Math.max(0, organization.exemptLimitCents - organization.exemptRemainingCents);
        const limitCents = Math.max(next.exemptLimitCents, usedCents);
        const key = `${limitCents}:${limitCents - usedCents}`;
        const group = groups.get(key) ?? { limitCents, remainingCents: limitCents - usedCents, ids: [] };
        group.ids.push(organization.id);
        groups.set(key, group);
      }
      for (const group of groups.values()) await tx.organization.updateMany({ where: { id: { in: group.ids }, ...eligible }, data: { exemptLimitCents: group.limitCents, exemptRemainingCents: group.remainingCents, updatedAt: now } });
      if (!sameCopy) organizationsUpdated = organizations.length;
    }
    await writeAudit(tx, { ...auditWho(actor, meta), action: 'rules.global_updated', targetType: 'GlobalConfig', targetId: 'GLOBAL', metadata: { changes, organizationsUpdated } });
    return { changed, organizationsUpdated };
  });
}

// --- Medallas ------------------------------------------------------------------------------------------------------------------------------

/**
 * Niveles de las medallas: campañas necesarias y beca exenta. **Se aplican desde la próxima renovación de cupos (cambio de curso) y a las medallas que se
 * ganen a partir de ahora**: la beca que una entidad tiene disponible este curso puede estar ya en parte reservada por una campaña, y cambiársela a mitad
 * del curso daría o quitaría exento a una pizarra ya calculada.
 */
export async function saveMedals(db: Db, actor: VerifiedSuperadminActor, raw: unknown, expectedUpdatedAt: string, now: Date = new Date(), meta?: RequestMeta): Promise<void> {
  assertVerifiedSuperadmin(actor, 'rules.medals_update', now);
  const parsed = medalsSchema.safeParse(raw);
  if (!parsed.success) throw new GlobalRulesRejectedError('INVALID', [...new Set(parsed.error.issues.map((issue) => String(issue.path[1] ?? issue.path[0] ?? 'form')))]);
  const tiers: MedalsInput = parsed.data;
  await inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'rules.medals_update', now);
    const rows = await tx.medalTierConfig.findMany({ select: { key: true, campaignsRequired: true, grantCents: true, updatedAt: true } });
    if (medalsVersion(rows) !== expectedUpdatedAt) throw new GlobalRulesRejectedError('STALE');
    const changes: Record<string, { from: { campaigns: number; grantCents: number }; to: { campaigns: number; grantCents: number } }> = {};
    for (const tier of tiers) {
      const current = rows.find((row) => row.key === tier.key);
      if (!current) throw new GlobalRulesRejectedError('INVALID', [tier.key]);
      if (current.campaignsRequired === tier.campaignsRequired && current.grantCents === tier.grantCents) continue;
      const { count } = await tx.medalTierConfig.updateMany({ where: { key: tier.key, updatedAt: current.updatedAt }, data: { campaignsRequired: tier.campaignsRequired, grantCents: tier.grantCents } });
      if (count === 0) throw new GlobalRulesRejectedError('STALE');
      changes[tier.key] = { from: { campaigns: current.campaignsRequired, grantCents: current.grantCents }, to: { campaigns: tier.campaignsRequired, grantCents: tier.grantCents } };
    }
    if (Object.keys(changes).length > 0) await writeAudit(tx, { ...auditWho(actor, meta), action: 'rules.medals_updated', targetType: 'MedalTierConfig', targetId: 'ALL', metadata: { changes } });
  });
}

/** Versión de las tres medallas juntas (la fecha más reciente): lo que la pantalla devuelve al guardar. */
export function medalsVersion(rows: ReadonlyArray<{ updatedAt: Date }>): string {
  return new Date(Math.max(0, ...rows.map((row) => row.updatedAt.getTime()))).toISOString();
}

export interface MedalsView {
  tiers: Array<{ key: string; name: string; icon: string; campaignsRequired: number; grantCents: number }>;
  updatedAt: string;
}

export async function loadMedalsView(db: Db): Promise<MedalsView> {
  const rows = await db.medalTierConfig.findMany({ orderBy: { rank: 'asc' }, select: { key: true, name: true, icon: true, campaignsRequired: true, grantCents: true, updatedAt: true } });
  return { tiers: rows.map(({ updatedAt: _updatedAt, ...tier }) => tier), updatedAt: medalsVersion(rows) };
}

// --- Categorías globales -------------------------------------------------------------------------------------------------------------------

/** Categoría global nueva. Una entidad la ve en cuanto existe; una categoría propia de la entidad con el mismo nombre sigue mandando sobre ella. */
export async function addGlobalCategory(db: Db, actor: VerifiedSuperadminActor, raw: unknown, now: Date = new Date(), meta?: RequestMeta): Promise<void> {
  assertVerifiedSuperadmin(actor, 'rules.category_add', now);
  const parsed = categorySchema.safeParse(raw);
  if (!parsed.success) throw new GlobalRulesRejectedError('INVALID', invalidRuleFields(parsed.error));
  const { name, icon, rule } = parsed.data;
  try {
    await inTransaction(db, async (tx) => {
      await revalidateActor(tx, actor, 'rules.category_add', now);
      const { _max } = await tx.globalCategory.aggregate({ _max: { sortOrder: true } });
      await tx.globalCategory.create({ data: { name, icon, rule, sortOrder: (_max.sortOrder ?? 0) + 1 } });
      await writeAudit(tx, { ...auditWho(actor, meta), action: 'rules.category_added', targetType: 'GlobalCategory', targetId: name, metadata: { category: name, categoryRule: rule } });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new GlobalRulesRejectedError('CATEGORY_EXISTS', ['name']);
    throw error;
  }
}

/** Pasa una categoría global a exenta (0 %) o por tramos. Solo afecta a las campañas que se calculen desde ahora. */
export async function setGlobalCategoryRule(db: Db, actor: VerifiedSuperadminActor, raw: unknown, now: Date = new Date(), meta?: RequestMeta): Promise<void> {
  assertVerifiedSuperadmin(actor, 'rules.category_rule', now);
  const parsed = categoryRuleSchema.safeParse(raw);
  if (!parsed.success) throw new GlobalRulesRejectedError('INVALID', ['name']);
  const { name, rule } = parsed.data;
  await inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'rules.category_rule', now);
    const current = await tx.globalCategory.findUnique({ where: { name }, select: { id: true, rule: true } });
    if (!current) throw new GlobalRulesRejectedError('CATEGORY_NOT_FOUND', ['name']);
    if (current.rule === rule) return;
    await tx.globalCategory.update({ where: { id: current.id }, data: { rule } });
    await writeAudit(tx, { ...auditWho(actor, meta), action: 'rules.category_rule_set', targetType: 'GlobalCategory', targetId: name, metadata: { category: name, previousRule: current.rule, categoryRule: rule } });
  });
}

// --- «Aceptar y registrar» un aviso de precios ----------------------------------------------------------------------------------------------

/**
 * Asume a propósito una pérdida o una incoherencia (por ejemplo, la Hucha como coste de captación). Pide una nota obligatoria y guarda la aceptación en
 * `pricing.acknowledgements` con la huella que se vio en pantalla: **solo vale mientras el aviso siga siendo el mismo**. Si la configuración cambió entre
 * que se abrió la pantalla y se pulsó el botón, el aviso es otro (`ALERT_CHANGED`) y no se acepta a ciegas. Es idempotente: aceptar dos veces lo mismo no
 * duplica nada. Queda en la auditoría (`PRICING_ALERT_ACKNOWLEDGED`).
 */
export async function acknowledgePricingAlert(db: Db, actor: VerifiedSuperadminActor, rawTarget: unknown, rawNote: unknown, now: Date = new Date(), meta?: RequestMeta): Promise<{ alreadyAccepted: boolean }> {
  assertVerifiedSuperadmin(actor, 'pricing.acknowledge', now);
  const target = pricingAcknowledgeTarget.safeParse(rawTarget);
  const note = reviewNote.safeParse(rawNote);
  if (!target.success || !note.success) throw new GlobalRulesRejectedError('INVALID', note.success ? ['code'] : ['note']);
  const { code, fingerprint, source } = target.data;
  const result = await inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'pricing.acknowledge', now);
    // Las reglas se leen dentro de la transacción: el aviso que se acepta es el que hay ahora, no el que se vio al abrir la pantalla.
    const { alerts } = await loadPricingHealth(tx);
    const alert = alerts.find((candidate) => candidate.code === code && candidate.fingerprint === fingerprint && (candidate.source ?? undefined) === source);
    if (!alert) {
      const stillThere = alerts.some((candidate) => candidate.code === code && (candidate.source ?? undefined) === source);
      throw new GlobalRulesRejectedError(stillThere ? 'ALERT_CHANGED' : 'ALERT_NOT_FOUND');
    }
    // «Ya aceptado» se decide con la fila leída aquí dentro, no con la caché de 30 s de los ajustes de este proceso (auditoría financiera del 5.3, M4).
    const definition = SETTING_DEFINITIONS['pricing.acknowledgements'];
    const row = await tx.platformSetting.findUnique({ where: { key: 'pricing.acknowledgements' }, select: { valueJson: true, version: true } });
    const current = row ? definition.schema.parse(row.valueJson) : [];
    if (current.some((item) => item.code === code && item.fingerprint === fingerprint)) return { alreadyAccepted: true };
    const entry = { code, fingerprint, acknowledgedById: actor.userId, acknowledgedAt: now.toISOString(), note: note.data };
    // Si hay que recortar, se conservan siempre las que siguen valiendo para un aviso actual y se tiran primero las más antiguas de las demás (M5).
    const stillCurrent = (item: { code: string; fingerprint: string }) => alerts.some((candidate) => candidate.code === item.code && candidate.fingerprint === item.fingerprint);
    const kept = current.filter(stillCurrent);
    const others = current.filter((item) => !stillCurrent(item));
    const room = Math.max(0, MAX_ACKNOWLEDGEMENTS - kept.length - 1);
    const list = [...(room > 0 ? others.slice(-room) : []), ...kept, entry];
    if (row) {
      const { count } = await tx.platformSetting.updateMany({ where: { key: 'pricing.acknowledgements', version: row.version }, data: { valueJson: list, version: row.version + 1, updatedById: actor.userId } });
      // Otra aceptación a la vez: se vuelve a leer y se reintenta desde fuera (el servidor responde `STALE` y la pantalla se recarga).
      if (count === 0) throw new GlobalRulesRejectedError('STALE');
    } else {
      await tx.platformSetting.create({ data: { key: 'pricing.acknowledgements', valueJson: list, version: 1, updatedById: actor.userId } });
    }
    await writeAudit(tx, { ...auditWho(actor, meta), action: 'PRICING_ALERT_ACKNOWLEDGED', targetType: 'PricingAlert', targetId: source ? `${code}:${source}` : code, metadata: { alertCode: code, source: source ?? null, note: note.data } });
    return { alreadyAccepted: false };
  });
  invalidateSettingsCache('pricing.acknowledgements');
  return result;
}
