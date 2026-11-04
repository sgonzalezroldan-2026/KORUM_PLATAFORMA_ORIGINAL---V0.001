import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renewOrganizationQuotas, releaseInitiativeQuotas, reserveInitiativeQuotas } from '@/core/finance/quota-reservation';
import { campaignExpiryHandler } from '@/core/jobs/handlers/campaign-expiry';
import { housekeepingHandler } from '@/core/jobs/handlers/housekeeping';
import { quotaRenewalHandler } from '@/core/jobs/handlers/quota-renewal';
import { creditPoolExpiryHandler, monthlyTopupHandler, sponsorRenewalChargeHandler, sponsorRenewalNoticeHandler } from '@/core/jobs/handlers/recurring-billing';
import { splitWindowGuardHandler } from '@/core/jobs/handlers/split-window-guard';
import { JOB_LOCK_TTL_MS, runJob } from '@/core/jobs/job-runner';
import { retryDelayMs, slotKey } from '@/core/jobs/job-schedule';
import type { JobDeps, JobHandler } from '@/core/jobs/job-types';
import type { JobType } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { createInitiative, createOrganization, createTestClient, createUser, uniqueId } from './test-database';

let db: KorumPrismaClient;

const deps: JobDeps = {
  paymentProvider: () => Promise.reject(new Error('no se usa en este archivo')),
  invoicingProvider: () => {
    throw new Error('no se usa en este archivo');
  },
  refundOriginalIp: async () => '10.0.0.1'
};

const MINUTE = 60_000;
const DAY = 86_400_000;
const run = (type: JobType, handler: JobHandler, now: Date) => runJob({ db, type, handler, deps, now });
/** Un `now` único por prueba (año distinto): las tareas diarias solo se ejecutan una vez por día y la base no se limpia entre pruebas. */
let year = 2100;
const uniqueDay = () => new Date(Date.UTC((year += 1), 5, 15, 10, 0, 0));

beforeAll(() => {
  db = createTestClient();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('QA-OPS01 · procesador de tareas', () => {
  it('dos llamadas seguidas dentro del mismo hueco ejecutan el trabajo una sola vez', async () => {
    const now = uniqueDay();
    const handler = vi.fn<JobHandler>(async () => ({ processed: 3, hasMore: false }));
    const first = await run('OPS_HOUSEKEEPING', handler, now);
    const second = await run('OPS_HOUSEKEEPING', handler, new Date(now.getTime() + 3 * 3_600_000));
    expect(first).toMatchObject([{ outcome: 'DONE', processed: 3 }]);
    expect(second).toEqual([]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await db.job.findUniqueOrThrow({ where: { idempotencyKey: slotKey('OPS_HOUSEKEEPING', now) } })).toMatchObject({ status: 'DONE', attempts: 1, lockedBy: null, payloadJson: { processed: 3, hasMore: false } });
  });

  it('dos servidores a la vez no ejecutan lo mismo', async () => {
    const now = uniqueDay();
    const handler = vi.fn<JobHandler>(async () => ({ processed: 1, hasMore: false }));
    await Promise.all([run('QUOTA_RENEWAL', handler, now), run('QUOTA_RENEWAL', handler, now)]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('un fallo se reintenta con espera creciente y, al agotar los intentos, queda en la consola', async () => {
    const start = uniqueDay();
    const key = slotKey('SPLIT_WINDOW_GUARD', start);
    const handler = vi.fn<JobHandler>(async () => Promise.reject(new Error('Paycomet no responde')));
    const onError = vi.fn();
    let now = start;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const [execution] = await runJob({ db, type: 'SPLIT_WINDOW_GUARD', handler, deps, now, onError });
      expect(execution).toMatchObject({ key, outcome: attempt < 5 ? 'RETRY' : 'FAILED', error: 'Error: Paycomet no responde' });
      if (attempt < 5) {
        const job = await db.job.findUniqueOrThrow({ where: { idempotencyKey: key } });
        expect(job).toMatchObject({ status: 'PENDING', attempts: attempt, lockedBy: null });
        expect(job.runAt.getTime()).toBe(now.getTime() + retryDelayMs(attempt));
        // Antes de que pase la espera no se vuelve a intentar.
        expect(await run('SPLIT_WINDOW_GUARD', handler, new Date(now.getTime() + retryDelayMs(attempt) - 1_000))).toEqual([]);
        now = new Date(now.getTime() + retryDelayMs(attempt));
      }
    }
    expect(handler).toHaveBeenCalledTimes(5);
    expect(onError).toHaveBeenCalledTimes(5);
    expect(await db.job.findUniqueOrThrow({ where: { idempotencyKey: key } })).toMatchObject({ status: 'FAILED', attempts: 5 });
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `JOB_FAILED:${key}` } })).toMatchObject({ type: 'JOB_FAILED', severity: 'CRITICAL', status: 'OPEN', detailJson: { jobType: 'SPLIT_WINDOW_GUARD', attempts: 5 } });
    // Agotado, ya no se vuelve a intentar.
    expect(await run('SPLIT_WINDOW_GUARD', handler, new Date(now.getTime() + 60 * MINUTE))).toEqual([]);
    expect(handler).toHaveBeenCalledTimes(5);
  });

  it('un reintento de un hueco anterior se recoge aunque ya haya empezado otro', async () => {
    const start = uniqueDay();
    let calls = 0;
    const flaky: JobHandler = async () => {
      calls += 1;
      if (calls === 1) throw new Error('fallo puntual');
      return { processed: 1, hasMore: false };
    };
    expect(await run('MODEL182_REMINDER', flaky, start)).toMatchObject([{ outcome: 'RETRY' }]);
    const nextDay = new Date(start.getTime() + DAY);
    const results = await run('MODEL182_REMINDER', flaky, nextDay);
    expect(results.map((result) => result.outcome).sort()).toEqual(['DONE', 'DONE']);
    expect(await db.job.findUniqueOrThrow({ where: { idempotencyKey: slotKey('MODEL182_REMINDER', start) } })).toMatchObject({ status: 'DONE', attempts: 2 });
  });

  it('una ejecución «en marcha» que se perdió por una caída se recupera pasado el bloqueo', async () => {
    const now = uniqueDay();
    await db.job.create({ data: { idempotencyKey: slotKey('TICKET_HOLD_RELEASE', now), type: 'TICKET_HOLD_RELEASE', payloadJson: {}, runAt: now, status: 'RUNNING', attempts: 1, lockedAt: new Date(now.getTime() - JOB_LOCK_TTL_MS - MINUTE), lockedBy: 'cron:caido' } });
    const handler = vi.fn<JobHandler>(async () => ({ processed: 0, hasMore: false }));
    expect(await run('TICKET_HOLD_RELEASE', handler, now)).toMatchObject([{ outcome: 'DONE' }]);
    expect(await db.job.findUniqueOrThrow({ where: { idempotencyKey: slotKey('TICKET_HOLD_RELEASE', now) } })).toMatchObject({ status: 'DONE', attempts: 2 });
  });

  it('una ejecución en marcha y reciente no se toca', async () => {
    const now = uniqueDay();
    await db.job.create({ data: { idempotencyKey: slotKey('INVOICE_SUBMIT', now), type: 'INVOICE_SUBMIT', payloadJson: {}, runAt: now, status: 'RUNNING', attempts: 1, lockedAt: new Date(now.getTime() - MINUTE), lockedBy: 'cron:otro' } });
    const handler = vi.fn<JobHandler>(async () => ({ processed: 0, hasMore: false }));
    expect(await run('INVOICE_SUBMIT', handler, now)).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('QA-OPS01 · CAMPAIGN_EXPIRY pasa cada iniciativa a EXPIRED una sola vez', () => {
  async function untilExpired(initiativeId: number, start: Date) {
    for (let step = 0; step < 12; step += 1) {
      await run('CAMPAIGN_EXPIRY', campaignExpiryHandler, new Date(start.getTime() + step * 61 * MINUTE));
      if ((await db.initiative.findUniqueOrThrow({ where: { id: initiativeId } })).status !== 'FUNDRAISING') return;
    }
  }

  it('vence la que pasó su fecha sin meta, avisa a quienes firman y no toca la que sigue en plazo ni la que logró la meta', async () => {
    const start = new Date();
    const organization = await createOrganization(db);
    const director = await createUser(db);
    const cosigner = await createUser(db);
    await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' }] });
    const overdue = await createInitiative(db, organization.id, { status: 'FUNDRAISING', closesAt: new Date(start.getTime() - DAY), goalCents: 10_000, raisedCents: 2_000 });
    const inTime = await createInitiative(db, organization.id, { status: 'FUNDRAISING', closesAt: new Date(start.getTime() + 5 * DAY) });
    const reached = await createInitiative(db, organization.id, { status: 'FUNDRAISING', closesAt: new Date(start.getTime() - DAY), goalCents: 1_000, raisedCents: 1_000 });

    await untilExpired(overdue.id, start);
    // Una segunda pasada no vuelve a cambiar nada ni a avisar.
    await run('CAMPAIGN_EXPIRY', campaignExpiryHandler, new Date(start.getTime() + 20 * 61 * MINUTE));

    const status = async (id: number) => (await db.initiative.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(overdue.id)).toBe('EXPIRED');
    expect(await status(inTime.id)).toBe('FUNDRAISING');
    expect(await status(reached.id)).toBe('FUNDRAISING');
    expect(await db.auditLog.count({ where: { action: 'initiative.expired', targetId: String(overdue.id) } })).toBe(1);
    const notices = await db.outboxMessage.findMany({ where: { templateKey: 'initiative.expired', organizationId: organization.id } });
    expect(notices.map((notice) => notice.userId).sort()).toEqual([director.id, cosigner.id].sort());
    expect(notices.every((notice) => notice.status === 'PENDING')).toBe(true);
  });

  it('las que no pueden vencer no dejan sin atender a las que vienen detrás, aunque el lote sea de una sola', async () => {
    const now = new Date();
    const organization = await createOrganization(db);
    // Primero en la cola, con la fecha más antigua y la meta cumplida: nunca vencerán.
    const stuck = await Promise.all([1, 2, 3].map(() => createInitiative(db, organization.id, { status: 'FUNDRAISING', closesAt: new Date(now.getTime() - 2 * DAY), goalCents: 1_000, raisedCents: 1_000 })));
    const overdue = await createInitiative(db, organization.id, { status: 'FUNDRAISING', closesAt: new Date(now.getTime() - DAY), goalCents: 10_000, raisedCents: 2_000 });

    const result = await campaignExpiryHandler({ db, now, batchSize: 1, deps });
    expect(result.hasMore).toBe(false);
    expect(result.detail?.expired).toBeGreaterThanOrEqual(1);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: overdue.id } })).status).toBe('EXPIRED');
    for (const initiative of stuck) expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('FUNDRAISING');
  });
});

describe('renovación anual de cupos', () => {
  /** Mismo registro que usan la semilla y las pruebas de cupos (clave `silver`): otra clave con el mismo rango chocaría con ellas. */
  const silverTier = () =>
    db.medalTierConfig.upsert({ where: { key: 'silver' }, create: { key: 'silver', name: 'Plata', icon: '🥈', rank: 2, campaignsRequired: 2, grantCents: 100_000 }, update: {} });

  it('repone exento, beca de medalla y mantenimiento; las reservas del curso anterior ya no abonan al nuevo', async () => {
    const silver = await silverTier();
    const organization = await createOrganization(db, { quotaPeriod: '2025-2026', exemptLimitCents: 100_000, exemptRemainingCents: 20_000, medalRank: 2, medalGrantAvailableCents: 0, medalGrantUsedInTitle: 'Toldos', maintPaidCents: 9_800, completedThisYear: 3 });
    const old = await createInitiative(db, organization.id, { status: 'FUNDRAISING', academicYear: '2025-2026', quotaReservedAt: new Date('2026-03-01T10:00:00Z'), quotaReservedExemptCents: 5_000, quotaReservedPeriod: '2025-2026' });

    // Las entidades que dejaron otras pruebas se ponen al día antes, para que cada pasada (un lote) llegue a la de esta prueba.
    await db.organization.updateMany({ where: { id: { not: organization.id }, OR: [{ quotaPeriod: null }, { quotaPeriod: { lt: '2026-2027' } }] }, data: { quotaPeriod: '2026-2027' } });
    await run('QUOTA_RENEWAL', quotaRenewalHandler, new Date('2026-11-04T04:30:00Z'));
    expect(await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).toMatchObject({ quotaPeriod: '2026-2027', exemptRemainingCents: 100_000, medalGrantAvailableCents: silver.grantCents, medalGrantUsedInTitle: null, maintPaidCents: 0, completedThisYear: 0 });
    expect(await db.auditLog.count({ where: { action: 'quota.renewed', targetId: organization.id } })).toBe(1);

    // La reserva del curso anterior se cierra sin abonar al nuevo.
    expect(await releaseInitiativeQuotas(db, old.id)).toEqual({ released: true, credited: false });
    expect(await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).toMatchObject({ exemptRemainingCents: 100_000 });
  });

  it('repetirla, o intentar volver a un curso anterior, no hace nada', async () => {
    const organization = await createOrganization(db, { quotaPeriod: '2026-2027', exemptRemainingCents: 40_000 });
    expect(await renewOrganizationQuotas(db, organization.id, '2026-2027')).toEqual({ renewed: false });
    expect(await renewOrganizationQuotas(db, organization.id, '2025-2026')).toEqual({ renewed: false });
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).exemptRemainingCents).toBe(40_000);
  });

  it('dos renovaciones simultáneas renuevan una sola vez', async () => {
    const organization = await createOrganization(db, { quotaPeriod: '2025-2026', exemptRemainingCents: 1_000 });
    const results = await Promise.all([renewOrganizationQuotas(db, organization.id, '2026-2027'), renewOrganizationQuotas(db, organization.id, '2026-2027')]);
    expect(results.filter((result) => result.renewed)).toHaveLength(1);
  });

  it('una entidad sin curso asignado solo recibe el curso: no se le repone el exento que ya haya gastado', async () => {
    const organization = await createOrganization(db, { quotaPeriod: null, exemptLimitCents: 100_000, exemptRemainingCents: 40_000, maintPaidCents: 4_900 });
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING', quotaReservedAt: new Date('2026-10-01T10:00:00Z'), quotaReservedExemptCents: 60_000, quotaReservedPeriod: null });
    expect(await renewOrganizationQuotas(db, organization.id, '2026-2027')).toEqual({ renewed: true });
    expect(await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).toMatchObject({ quotaPeriod: '2026-2027', exemptRemainingCents: 40_000, maintPaidCents: 4_900 });
    expect(await db.auditLog.count({ where: { action: 'quota.period_assigned', targetId: organization.id } })).toBe(1);
    // Su reserva abierta pasa al mismo curso, así que si la campaña se cancela el cupo se abona.
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).quotaReservedPeriod).toBe('2026-2027');
    expect(await releaseInitiativeQuotas(db, initiative.id)).toEqual({ released: true, credited: true });
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).exemptRemainingCents).toBe(100_000);
  });
});

describe('QA-P04 · SPLIT_WINDOW_GUARD', () => {
  it('avisa a los 15 días de que venza la ventana, una sola vez a la entidad, y marca como crítica la que ya venció', async () => {
    const now = new Date();
    const organization = await createOrganization(db);
    const director = await createUser(db);
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: director.id, role: 'DIRECTOR' } });
    const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);
    const expiring = await createInitiative(db, organization.id, { status: 'GOAL_REACHED', firstPayinAt: daysAgo(80), raisedCents: 5_000 });
    const expired = await createInitiative(db, organization.id, { status: 'GOAL_REACHED', firstPayinAt: daysAgo(95), raisedCents: 5_000 });
    const fresh = await createInitiative(db, organization.id, { status: 'GOAL_REACHED', firstPayinAt: daysAgo(10), raisedCents: 5_000 });
    const closed = await createInitiative(db, organization.id, { status: 'CLOSED', firstPayinAt: daysAgo(85), raisedCents: 5_000 });

    await run('SPLIT_WINDOW_GUARD', splitWindowGuardHandler, now);
    await run('SPLIT_WINDOW_GUARD', splitWindowGuardHandler, new Date(now.getTime() + DAY));

    const alert = (id: number) => db.opsAlert.findUnique({ where: { dedupeKey: `SPLIT_WINDOW_EXPIRING:${id}` } });
    expect(await alert(expiring.id)).toMatchObject({ severity: 'WARNING', status: 'OPEN', occurrences: 2, organizationId: organization.id });
    expect(await alert(expired.id)).toMatchObject({ severity: 'CRITICAL', status: 'OPEN' });
    expect(await alert(fresh.id)).toBeNull();
    expect(await alert(closed.id)).toBeNull();
    const notices = await db.outboxMessage.findMany({ where: { organizationId: organization.id, templateKey: { in: ['split.windowExpiring', 'split.windowExpired'] } } });
    expect(notices.map((notice) => notice.templateKey).sort()).toEqual(['split.windowExpired', 'split.windowExpiring']);
  });

  it('la alerta se cierra sola cuando la iniciativa se liquida', async () => {
    // Otro día que la prueba anterior: la tarea solo se ejecuta una vez por día.
    const now = new Date(Date.now() + 5 * DAY);
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id, { status: 'GOAL_REACHED', firstPayinAt: new Date(now.getTime() - 82 * DAY) });
    await run('SPLIT_WINDOW_GUARD', splitWindowGuardHandler, now);
    expect((await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `SPLIT_WINDOW_EXPIRING:${initiative.id}` } })).status).toBe('OPEN');
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'CLOSED' } });
    await run('SPLIT_WINDOW_GUARD', splitWindowGuardHandler, new Date(now.getTime() + DAY));
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `SPLIT_WINDOW_EXPIRING:${initiative.id}` } })).toMatchObject({ status: 'RESOLVED', resolvedAt: expect.any(Date) });
  });
});

describe('OPS_HOUSEKEEPING · limpieza diaria', () => {
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');

  it('purga contadores caducados, notificaciones rechazadas de más de 90 días y desafíos de firma antiguos, y nada más', async () => {
    const now = new Date();
    const tag = uniqueId('hk');
    const longAgo = (days: number) => new Date(now.getTime() - days * DAY);

    // Contadores de intentos: el de IP caducado se borra, el reciente y el del evento (sin ventana) se quedan.
    const staleIp = `gate-pin:ip:1:${tag}-old`;
    const freshIp = `gate-pin:ip:1:${tag}-new`;
    const eventCounter = `gate-pin:event:${tag}`;
    await reserveAttempt(db, staleIp, { limit: 5, windowMs: 900_000 }, new Date(now.getTime() - 3_600_000));
    await reserveAttempt(db, freshIp, { limit: 5, windowMs: 900_000 }, new Date(now.getTime() - 60_000));
    await reserveAttempt(db, eventCounter, { limit: 20, windowMs: null }, longAgo(300));

    // Notificaciones de pago.
    const row = (externalEventId: string, status: 'REJECTED' | 'PROCESSED', receivedAt: Date) => ({ provider: 'paycomet', externalEventId, signatureValid: status === 'PROCESSED', payloadJson: {}, status, receivedAt });
    await db.webhookEvent.createMany({
      data: [row(`rejected:${tag}-100d`, 'REJECTED', longAgo(100)), row(`rejected:${tag}-80d`, 'REJECTED', longAgo(80)), row(`1:${tag}-valid-old`, 'PROCESSED', longAgo(400)), row(`${tag}-not-prefixed`, 'REJECTED', longAgo(100))]
    });

    // Desafíos de firma.
    const organization = await createOrganization(db);
    const signer = await createUser(db);
    const idea = await db.idea.create({ data: { organizationId: organization.id, alias: 'Familia', authorCanonicalEmail: signer.canonicalEmail, title: 'Idea', category: 'Patios', description: 'x', expiresAt: longAgo(-30) } });
    const challenge = (name: string, expiresAt: Date, extra: { consumedAt?: Date } = {}) => ({ organizationId: organization.id, targetType: 'IDEA_APPROVAL' as const, ideaId: idea.id, signerUserId: signer.id, signerRole: 'DIRECTOR' as const, tokenHash: sha(`${tag}-${name}`), otpHmac: sha('otp'), targetDigest: sha('digest'), expiresAt, ...extra });
    await db.doubleCheckChallenge.createMany({ data: [challenge('expired-10d', longAgo(10)), challenge('expired-1d', longAgo(1)), challenge('valid', longAgo(-2)), challenge('consumed-9d', longAgo(-5), { consumedAt: longAgo(9) })] });

    await run('OPS_HOUSEKEEPING', housekeepingHandler, now);

    const keys = (await db.rateLimit.findMany({ where: { key: { contains: tag } } })).map((entry) => entry.key).sort();
    expect(keys).toEqual([eventCounter, freshIp].sort());
    const events = (await db.webhookEvent.findMany({ where: { externalEventId: { contains: tag } } })).map((event) => event.externalEventId).sort();
    expect(events).toEqual([`${tag}-not-prefixed`, `1:${tag}-valid-old`, `rejected:${tag}-80d`].sort());
    const challenges = await db.doubleCheckChallenge.findMany({ where: { ideaId: idea.id } });
    expect(challenges.map((entry) => entry.tokenHash).sort()).toEqual([sha(`${tag}-expired-1d`), sha(`${tag}-valid`)].sort());
  });
});

describe('tareas de cobros recurrentes (sin mover dinero)', () => {
  it('el preaviso de renovación se escribe una vez por patrocinio y vencimiento', async () => {
    const now = new Date();
    const organization = await createOrganization(db);
    const sponsor = await db.sponsor.create({
      data: { organizationId: organization.id, name: 'Comercio', cif: 'B12345674', contactPerson: 'Persona', phone: '600000000', email: `${uniqueId('comercio')}@pruebas.example`, sector: 'Panadería', tierLabel: 'Plata', amountCents: 25_000, feeGeneratedCents: 3_750, promo: 'x', code: uniqueId('C'), status: 'APPROVED', autoRenew: true, expiresAt: new Date(now.getTime() + 20 * DAY) }
    });
    for (let step = 0; step < 3; step += 1) await run('SPONSOR_RENEWAL_NOTICE', sponsorRenewalNoticeHandler, new Date(now.getTime() + step * DAY));
    const notices = await db.outboxMessage.findMany({ where: { templateKey: 'sponsor.renewalNotice', organizationId: organization.id } });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ toAddress: sponsor.email, payloadJson: { sponsorId: sponsor.id, amountCents: 25_000 } });
  });

  it('lo vencido que aún no se puede cobrar queda en una alerta agregada y desaparece solo al resolverse', async () => {
    const now = new Date();
    const organization = await createOrganization(db);
    const sponsor = await db.sponsor.create({
      data: { organizationId: organization.id, name: 'Comercio', cif: 'B12345674', contactPerson: 'Persona', phone: '600000000', email: `${uniqueId('comercio')}@pruebas.example`, sector: 'Panadería', tierLabel: 'Plata', amountCents: 25_000, feeGeneratedCents: 3_750, promo: 'x', code: uniqueId('C'), status: 'APPROVED', autoRenew: true, expiresAt: new Date(now.getTime() - DAY) }
    });
    await run('SPONSOR_RENEWAL_CHARGE', sponsorRenewalChargeHandler, now);
    const alert = await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: 'SPONSOR_RENEWAL_DUE:global' } });
    expect(alert).toMatchObject({ status: 'OPEN', type: 'SPONSOR_RENEWAL_DUE' });
    expect(JSON.stringify(alert.detailJson)).not.toContain(sponsor.email);

    // Con todo en regla (para esta comprobación, sin patrocinios vencidos de nadie) la alerta se cierra.
    const nextDay = new Date(now.getTime() + DAY);
    await db.sponsor.updateMany({ where: { status: 'APPROVED', autoRenew: true, expiresAt: { lte: nextDay } }, data: { autoRenew: false } });
    await run('SPONSOR_RENEWAL_CHARGE', sponsorRenewalChargeHandler, nextDay);
    expect((await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: 'SPONSOR_RENEWAL_DUE:global' } })).status).toBe('RESOLVED');
  });

  it('las bolsas de patrocinio pasadas de 85 días y las aportaciones mensuales vencidas se señalan sin cobrar nada', async () => {
    const now = uniqueDay();
    const organization = await createOrganization(db);
    await db.sponsor.create({
      data: { organizationId: organization.id, name: 'Comercio', cif: 'B12345674', contactPerson: 'Persona', phone: '600000000', email: `${uniqueId('comercio')}@pruebas.example`, sector: 'Panadería', tierLabel: 'Plata', amountCents: 25_000, feeGeneratedCents: 3_750, promo: 'x', code: uniqueId('C'), status: 'CREDIT_POOL', paidAt: new Date(now.getTime() - 86 * DAY), expiresAt: new Date(now.getTime() + 30 * DAY) }
    });
    await run('CREDIT_POOL_EXPIRY', creditPoolExpiryHandler, now);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: 'CREDIT_POOL_EXPIRED:global' } })).toMatchObject({ severity: 'CRITICAL', status: 'OPEN' });
    expect(await run('MONTHLY_TOPUP', monthlyTopupHandler, now)).toMatchObject([{ outcome: 'DONE' }]);
  });
});

describe('QA-OPS01 · un bloqueo perdido no pisa a quien lo tomó', () => {
  it('si otro servidor reclama la ejecución mientras la lenta termina, el resultado de la lenta se descarta', async () => {
    const now = uniqueDay();
    const key = slotKey('INVOICE_SUBMIT', now);
    const slow: JobHandler = async () => {
      await db.job.updateMany({ where: { idempotencyKey: key }, data: { lockedBy: 'cron:otro-servidor' } });
      return { processed: 7, hasMore: false };
    };
    // Otras ejecuciones atrasadas del mismo tipo (de pruebas anteriores) también se atienden: se mira solo la de esta prueba.
    expect((await run('INVOICE_SUBMIT', slow, now)).find((execution) => execution.key === key)).toMatchObject({ outcome: 'LOST_LOCK', processed: 7 });
    expect(await db.job.findUniqueOrThrow({ where: { idempotencyKey: key } })).toMatchObject({ status: 'RUNNING', lockedBy: 'cron:otro-servidor' });
  });

  it('si la lenta falla, tampoco pisa el estado de quien la tomó ni abre alertas por ella', async () => {
    const now = uniqueDay();
    const key = slotKey('TICKET_HOLD_RELEASE', now);
    const slowAndFailing: JobHandler = async () => {
      await db.job.updateMany({ where: { idempotencyKey: key }, data: { lockedBy: 'cron:otro-servidor' } });
      throw new Error('fallo tardío');
    };
    expect((await run('TICKET_HOLD_RELEASE', slowAndFailing, now)).find((execution) => execution.key === key)).toMatchObject({ outcome: 'LOST_LOCK' });
    expect(await db.job.findUniqueOrThrow({ where: { idempotencyKey: key } })).toMatchObject({ status: 'RUNNING', lockedBy: 'cron:otro-servidor', attempts: 1 });
    expect(await db.opsAlert.findUnique({ where: { dedupeKey: `JOB_FAILED:${key}` } })).toBeNull();
  });

  it('el texto del error guardado no lleva datos de personas', async () => {
    const now = uniqueDay();
    const key = slotKey('OPS_HOUSEKEEPING', now);
    const leaky: JobHandler = async () => Promise.reject(new Error('No se pudo avisar a ana.garcia@correo.es con NIF 12345678Z'));
    expect(await run('OPS_HOUSEKEEPING', leaky, now)).toMatchObject([{ outcome: 'RETRY' }]);
    const job = await db.job.findUniqueOrThrow({ where: { idempotencyKey: key } });
    expect(job.lastError).toContain('No se pudo avisar a');
    expect(job.lastError).not.toMatch(/ana\.garcia|12345678Z/);
  });
});

describe('renovación de cupos al publicar y en la tarea', () => {
  const NOVEMBER = new Date('2026-11-04T04:30:00Z');

  it('publicar en una entidad que sigue en el curso anterior la renueva antes de reservar: no se gasta el sobrante viejo', async () => {
    const organization = await createOrganization(db, { quotaPeriod: '2025-2026', exemptLimitCents: 100_000, exemptRemainingCents: 10_000 });
    const initiative = await createInitiative(db, organization.id, { defaultExemptAppliedCents: 40_000 });
    await reserveInitiativeQuotas(db, initiative.id, new Date('2026-08-22T00:30:00Z'));
    expect(await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).toMatchObject({ quotaPeriod: '2026-2027', exemptRemainingCents: 60_000 });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).quotaReservedPeriod).toBe('2026-2027');
  });

  it('una entidad sin curso asignado no se toca al reservar', async () => {
    const organization = await createOrganization(db, { quotaPeriod: null, exemptLimitCents: 100_000, exemptRemainingCents: 100_000 });
    const initiative = await createInitiative(db, organization.id, { defaultExemptAppliedCents: 40_000 });
    await reserveInitiativeQuotas(db, initiative.id, NOVEMBER);
    expect(await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).toMatchObject({ quotaPeriod: null, exemptRemainingCents: 60_000 });
  });

  it('la tarea recorre todas las entidades pendientes en una sola ejecución, aunque el lote sea pequeño', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await createOrganization(db, { quotaPeriod: '2025-2026', exemptRemainingCents: 1 })).id);
    await db.organization.updateMany({ where: { id: { notIn: ids }, OR: [{ quotaPeriod: null }, { quotaPeriod: { lt: '2026-2027' } }] }, data: { quotaPeriod: '2026-2027' } });
    const result = await quotaRenewalHandler({ db, now: NOVEMBER, batchSize: 2, deps });
    expect(result).toMatchObject({ processed: 5, hasMore: false, detail: { renewed: 5 } });
    expect((await db.organization.findMany({ where: { id: { in: ids } } })).map((organization) => organization.quotaPeriod)).toEqual(Array(5).fill('2026-2027'));
  });
});

describe('recorridos completos aunque el lote sea pequeño', () => {
  const newSponsor = (organizationId: string, expiresAt: Date) =>
    db.sponsor.create({
      data: { organizationId, name: 'Comercio', cif: 'B12345674', contactPerson: 'Persona', phone: '600000000', email: `${uniqueId('comercio')}@pruebas.example`, sector: 'Panadería', tierLabel: 'Plata', amountCents: 25_000, feeGeneratedCents: 3_750, promo: 'x', code: uniqueId('C'), status: 'APPROVED', autoRenew: true, expiresAt }
    });

  it('el preaviso llega a todos los comercios de la ventana, no solo a los primeros del lote', async () => {
    const now = new Date(Date.now() + 40 * DAY);
    const organization = await createOrganization(db);
    for (let i = 0; i < 5; i += 1) await newSponsor(organization.id, new Date(now.getTime() + (10 + i) * DAY));
    const result = await sponsorRenewalNoticeHandler({ db, now, batchSize: 2, deps });
    expect(result.processed).toBeGreaterThanOrEqual(5);
    expect(await db.outboxMessage.count({ where: { templateKey: 'sponsor.renewalNotice', organizationId: organization.id } })).toBe(5);
  });

  it('la limpieza repite pasadas mientras queden filas por purgar', async () => {
    const tag = uniqueId('hk-rounds');
    const longAgo = new Date(Date.now() - 100 * DAY);
    await db.webhookEvent.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ provider: 'paycomet', externalEventId: `rejected:${tag}-${i}`, signatureValid: false, payloadJson: {}, status: 'REJECTED' as const, receivedAt: longAgo })) });
    const result = await housekeepingHandler({ db, now: new Date(), batchSize: 2, deps });
    expect(result.processed).toBeGreaterThanOrEqual(5);
    expect(await db.webhookEvent.count({ where: { externalEventId: { contains: tag } } })).toBe(0);
  });
});
