import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJob } from '@/core/jobs/job-runner';
import { outboxDispatchHandler } from '@/core/jobs/handlers/outbox-dispatch';
import { JOB_HANDLERS } from '@/core/jobs/job-registry';
import { JOB_SPECS } from '@/core/jobs/job-schedule';
import type { JobDeps } from '@/core/jobs/job-types';
import type { Prisma } from '@/generated/prisma/client';
import type { KorumPrismaClient } from '@/lib/prisma';
import { EmailConfigurationError, EmailSendError, type EmailMessage, type EmailProvider, type EmailSendResult } from '@/services/email/email-provider';
import { dispatchOutbox, OUTBOX_LEASE_MS, OUTBOX_MAX_ATTEMPTS, retryDelayMs, type OutboxDeps } from '@/services/email/outbox-processor';
import { createInitiative, createOrganization, createTestClient, createUser, testJobDeps, uniqueId } from './test-database';

let db: KorumPrismaClient;

beforeAll(() => {
  db = createTestClient();
});
afterAll(async () => {
  await db.$disconnect();
});

const MINUTE = 60_000;
const NOW = new Date('2026-11-04T10:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

/** Proveedor de pruebas: guarda lo que «envía» y falla cuando se le indica. */
class FakeProvider implements EmailProvider {
  readonly name = 'fake';
  readonly sent: EmailMessage[] = [];
  failWith: Error | null = null;
  delayMs = 0;

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
    return { providerMessageId: `fake-${this.sent.length}-${message.idempotencyKey}` };
  }
}

const SENDER = { fromAddress: 'no-responder@korum.test', fromName: 'KORUM', replyTo: 'ayuda@korum.test' };
const depsFor = (provider: () => Promise<EmailProvider>, sender: OutboxDeps['sender'] = async () => SENDER): OutboxDeps => ({
  provider,
  sender,
  appUrl: () => 'https://korum.test',
  qrSecret: () => 'integration-qr-hmac-secret-0123456789ab'
});

async function scenario() {
  const organization = await createOrganization(db, { name: 'AMPA del Sol' });
  const initiative = await createInitiative(db, organization.id, { title: 'Toldos del patio' });
  return { organization, initiative };
}

type MessageInput = Partial<Prisma.OutboxMessageUncheckedCreateInput> & { templateKey?: string };
async function queue(organizationId: string, initiativeId: number, overrides: MessageInput = {}) {
  return db.outboxMessage.create({
    data: {
      idempotencyKey: uniqueId('msg'),
      templateKey: 'refund.issued',
      toAddress: 'familia@pruebas.example',
      // Listo desde antes del reloj de pruebas: el valor por defecto sería la hora real de la base de datos.
      nextAttemptAt: new Date(NOW.getTime() - MINUTE),
      organizationId,
      payloadJson: { initiativeId, amountCents: 2_650 },
      ...overrides
    }
  });
}

const reload = (id: number) => db.outboxMessage.findUniqueOrThrow({ where: { id } });

describe('QA-NOT01 · la bandeja de salida envía, reintenta y deja constancia', () => {
  it('envía el mensaje con su plantilla, en su idioma y con el remitente «{Entidad} vía KORUM», y lo marca como enviado', async () => {
    const { organization, initiative } = await scenario();
    const provider = new FakeProvider();
    const message = await queue(organization.id, initiative.id, { locale: 'en' });

    const result = await dispatchOutbox(db, depsFor(async () => provider), { now: NOW, limit: 10, ids: [message.id] });

    expect(result).toMatchObject({ processed: 1, sent: 1, retried: 0, failed: 0, hasMore: false });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({ to: 'familia@pruebas.example', fromName: 'AMPA del Sol via KORUM', fromAddress: SENDER.fromAddress, replyTo: SENDER.replyTo, idempotencyKey: message.idempotencyKey });
    expect(provider.sent[0]?.subject).toBe('We have refunded your payment for “Toldos del patio”');
    expect(provider.sent[0]?.html).toContain('<html lang="en"');
    expect(provider.sent[0]?.text).toContain('€26.50');
    expect(await reload(message.id)).toMatchObject({ status: 'SENT', attempts: 1, lastError: null, sentAt: NOW, providerMessageId: `fake-1-${message.idempotencyKey}` });
  });

  it('dos procesos a la vez nunca envían el mismo mensaje dos veces', async () => {
    const { organization, initiative } = await scenario();
    const provider = new FakeProvider();
    provider.delayMs = 15;
    const messages = await Promise.all(Array.from({ length: 6 }, () => queue(organization.id, initiative.id)));
    const ids = messages.map((message) => message.id);
    const deps = depsFor(async () => provider);

    const results = await Promise.all([1, 2, 3].map(() => dispatchOutbox(db, deps, { now: NOW, limit: 10, ids })));

    expect(results.reduce((total, result) => total + result.sent, 0)).toBe(6);
    expect(new Set(provider.sent.map((sent) => sent.idempotencyKey)).size).toBe(6);
    expect(provider.sent).toHaveLength(6);
  });

  it('un fallo transitorio reintenta con espera creciente y no antes de tiempo; al volver el proveedor se envía', async () => {
    const { organization, initiative } = await scenario();
    const provider = new FakeProvider();
    provider.failWith = new EmailSendError('Brevo respondió 503.', false);
    const message = await queue(organization.id, initiative.id);
    const deps = depsFor(async () => provider);
    const options = { limit: 10, ids: [message.id] };

    expect(await dispatchOutbox(db, deps, { ...options, now: NOW })).toMatchObject({ retried: 1, sent: 0 });
    expect(await reload(message.id)).toMatchObject({ status: 'PENDING', attempts: 1, lastError: expect.stringContaining('503'), nextAttemptAt: later(retryDelayMs(1)) });

    // Antes de que toque no hace nada.
    expect(await dispatchOutbox(db, deps, { ...options, now: later(retryDelayMs(1) - 1) })).toMatchObject({ processed: 0 });
    expect((await reload(message.id)).attempts).toBe(1);

    provider.failWith = null;
    expect(await dispatchOutbox(db, deps, { ...options, now: later(retryDelayMs(1)) })).toMatchObject({ sent: 1 });
    expect(await reload(message.id)).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
  });

  it('al agotar los reintentos queda fallido y abre una alerta sin direcciones de email', async () => {
    const { organization, initiative } = await scenario();
    const provider = new FakeProvider();
    provider.failWith = new EmailSendError('Brevo respondió 500.', false);
    const message = await queue(organization.id, initiative.id, { toAddress: 'secreta.persona@pruebas.example' });
    const deps = depsFor(async () => provider);

    let clock = NOW;
    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      await dispatchOutbox(db, deps, { now: clock, limit: 10, ids: [message.id] });
      clock = new Date(clock.getTime() + retryDelayMs(attempt) + 1);
    }

    expect(await reload(message.id)).toMatchObject({ status: 'FAILED', attempts: OUTBOX_MAX_ATTEMPTS });
    const alert = await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: 'email:failed:refund.issued' } });
    expect(alert).toMatchObject({ type: 'EMAIL_DELIVERY_FAILED', status: 'OPEN' });
    expect(JSON.stringify(alert.detailJson)).not.toContain('secreta.persona');
    // Un mensaje fallido no se vuelve a intentar solo.
    expect(await dispatchOutbox(db, deps, { now: clock, limit: 10, ids: [message.id] })).toMatchObject({ processed: 0 });
  });

  it('un rechazo definitivo, una plantilla desconocida o datos que no cuadran fallan al primer intento sin reintentar', async () => {
    const { organization, initiative } = await scenario();
    const provider = new FakeProvider();
    const rejected = await queue(organization.id, initiative.id);
    const unknown = await queue(organization.id, initiative.id, { templateKey: 'no.existe' });
    const malformed = await queue(organization.id, initiative.id, { payloadJson: { initiativeId: initiative.id, amountCents: 'mucho' } });
    const ids = [rejected.id, unknown.id, malformed.id];

    provider.failWith = new EmailSendError('Brevo respondió 400.', true);
    const result = await dispatchOutbox(db, depsFor(async () => provider), { now: NOW, limit: 10, ids });

    expect(result).toMatchObject({ failed: 3, retried: 0, sent: 0 });
    for (const id of ids) expect(await reload(id)).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect((await reload(malformed.id)).lastError).toContain('amountCents');
    expect((await reload(unknown.id)).lastError).toContain('no.existe');
  });

  it('sin proveedor configurado los mensajes esperan sin gastar intentos, y se avisa al Super-Admin', async () => {
    const { organization, initiative } = await scenario();
    const messages = await Promise.all([queue(organization.id, initiative.id), queue(organization.id, initiative.id)]);
    // En orden de id, que es el de la bandeja: los dos se crean a la vez y la promesa no garantiza cuál llega antes (intermitente visto en el 4.4a).
    const ids = messages.map((message) => message.id).sort((a, b) => a - b);

    const result = await dispatchOutbox(db, depsFor(async () => Promise.reject(new EmailConfigurationError(['email.apiKey']))), { now: NOW, limit: 10, ids });

    // Se para en el primero: el resto fallaría igual.
    expect(result).toMatchObject({ sent: 0, failed: 0, hasMore: false });
    const first = await reload(ids[0]!);
    expect(first).toMatchObject({ status: 'PENDING', attempts: 0, nextAttemptAt: later(15 * MINUTE) });
    expect(first.lastError).toContain('email.apiKey');
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: 'email:configuration' } })).toMatchObject({ type: 'EMAIL_DELIVERY_FAILED', severity: 'CRITICAL' });

    // Sin remitente configurado ocurre lo mismo.
    const noSender = await dispatchOutbox(db, depsFor(async () => new FakeProvider(), async () => undefined), { now: later(16 * MINUTE), limit: 10, ids });
    expect(noSender).toMatchObject({ sent: 0 });
    expect((await reload(ids[0]!)).attempts).toBe(0);

    // Con la configuración arreglada salen los dos.
    expect(await dispatchOutbox(db, depsFor(async () => new FakeProvider()), { now: later(32 * MINUTE), limit: 10, ids })).toMatchObject({ sent: 2 });
  });
});

describe('QA-NOT02 · lo que no debe enviarse', () => {
  it('no escribe a cuentas suprimidas, ni a direcciones vacías o del dominio .invalid', async () => {
    const { organization, initiative } = await scenario();
    const provider = new FakeProvider();
    const erased = await createUser(db, { gdprAnonymizedAt: new Date() });
    const messages = [
      await queue(organization.id, initiative.id, { userId: erased.id }),
      await queue(organization.id, initiative.id, { toAddress: 'suprimida-u1@anonimizado.invalid' }),
      await queue(organization.id, initiative.id, { toAddress: '' })
    ];

    const result = await dispatchOutbox(db, depsFor(async () => provider), { now: NOW, limit: 10, ids: messages.map((message) => message.id) });

    expect(result).toMatchObject({ cancelled: 3, sent: 0 });
    expect(provider.sent).toHaveLength(0);
    for (const message of messages) expect(await reload(message.id)).toMatchObject({ status: 'CANCELLED', attempts: 1 });
  });

  it('un mensaje de una entidad no muestra datos de otra: si la iniciativa no es suya, no se envía', async () => {
    const mine = await scenario();
    const other = await scenario();
    const provider = new FakeProvider();
    const crossed = await queue(mine.organization.id, other.initiative.id);

    expect(await dispatchOutbox(db, depsFor(async () => provider), { now: NOW, limit: 10, ids: [crossed.id] })).toMatchObject({ failed: 1, sent: 0 });
    expect(provider.sent).toHaveLength(0);
    expect((await reload(crossed.id)).lastError).toContain('otra entidad');
  });

  it('el enlace y el código de un solo uso se borran del mensaje al enviarlo, al fallar y al cancelarlo, y no se envían caducados', async () => {
    const { organization, initiative } = await scenario();
    const provider = new FakeProvider();
    const secrets = (expiresAt: Date) => ({ targetType: 'IDEA_APPROVAL', targetTitle: 'Techar el patio', token: 'T'.repeat(43), otp: '482913', expiresAt: expiresAt.toISOString() });
    const sentOk = await queue(organization.id, initiative.id, { templateKey: 'doubleCheck.pending', payloadJson: secrets(later(72 * 60 * MINUTE)) });
    const expired = await queue(organization.id, initiative.id, { templateKey: 'doubleCheck.pending', payloadJson: secrets(later(-MINUTE)) });
    const rejected = await queue(organization.id, initiative.id, { templateKey: 'doubleCheck.pending', payloadJson: secrets(later(72 * 60 * MINUTE)), toAddress: 'rechazada@pruebas.example' });

    await dispatchOutbox(db, depsFor(async () => provider), { now: NOW, limit: 10, ids: [sentOk.id, expired.id] });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.text).toContain('482913');
    expect(provider.sent[0]?.text).toContain(`/panel/${organization.slug}/firmar#t=${'T'.repeat(43)}`);
    expect(await reload(sentOk.id)).toMatchObject({ status: 'SENT' });
    expect(await reload(expired.id)).toMatchObject({ status: 'CANCELLED', lastError: expect.stringContaining('caducó') });

    provider.failWith = new EmailSendError('Brevo respondió 400.', true);
    await dispatchOutbox(db, depsFor(async () => provider), { now: NOW, limit: 10, ids: [rejected.id] });
    expect(await reload(rejected.id)).toMatchObject({ status: 'FAILED' });

    for (const id of [sentOk.id, expired.id, rejected.id]) {
      const payload = (await reload(id)).payloadJson as Record<string, unknown>;
      expect(payload, `mensaje ${id}`).not.toHaveProperty('token');
      expect(payload, `mensaje ${id}`).not.toHaveProperty('otp');
      expect(payload.targetTitle).toBe('Techar el patio');
    }
  });

  it('un mensaje reservado por un proceso que cayó se recupera al vencer la reserva, y no antes', async () => {
    const { organization, initiative } = await scenario();
    const provider = new FakeProvider();
    const stuck = await queue(organization.id, initiative.id, { status: 'SENDING', attempts: 1, nextAttemptAt: later(OUTBOX_LEASE_MS) });
    const deps = depsFor(async () => provider);

    expect(await dispatchOutbox(db, deps, { now: later(OUTBOX_LEASE_MS - 1), limit: 10, ids: [stuck.id] })).toMatchObject({ processed: 0 });
    expect(await dispatchOutbox(db, deps, { now: later(OUTBOX_LEASE_MS), limit: 10, ids: [stuck.id] })).toMatchObject({ sent: 1 });
    expect(await reload(stuck.id)).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('el límite por llamada deja el resto para la siguiente y lo avisa con hasMore', async () => {
    const { organization, initiative } = await scenario();
    const provider = new FakeProvider();
    const messages = await Promise.all(Array.from({ length: 5 }, () => queue(organization.id, initiative.id)));
    const ids = messages.map((message) => message.id);
    const deps = depsFor(async () => provider);

    expect(await dispatchOutbox(db, deps, { now: NOW, limit: 3, ids })).toMatchObject({ sent: 3, hasMore: true });
    expect(await dispatchOutbox(db, deps, { now: NOW, limit: 3, ids })).toMatchObject({ sent: 2, hasMore: false });
  });
});

describe('QA-NOT02 · endurecimiento de la bandeja', () => {
  it('un mensaje que cita una iniciativa pero no indica su entidad no se envía: no habría con qué comprobar el aislamiento', async () => {
    const { organization, initiative } = await scenario();
    const provider = new FakeProvider();
    const orphan = await queue(organization.id, initiative.id, { organizationId: null });

    expect(await dispatchOutbox(db, depsFor(async () => provider), { now: NOW, limit: 10, ids: [orphan.id] })).toMatchObject({ failed: 1, sent: 0 });
    expect(provider.sent).toHaveLength(0);
    expect((await reload(orphan.id)).lastError).toContain('no indica su entidad');
  });

  it('un mensaje reclamado más veces que el máximo se da por fallido en lugar de insistir', async () => {
    const { organization, initiative } = await scenario();
    const provider = new FakeProvider();
    const crashing = await queue(organization.id, initiative.id, { status: 'SENDING', attempts: OUTBOX_MAX_ATTEMPTS, nextAttemptAt: new Date(NOW.getTime() - MINUTE) });

    expect(await dispatchOutbox(db, depsFor(async () => provider), { now: NOW, limit: 10, ids: [crashing.id] })).toMatchObject({ failed: 1, sent: 0 });
    expect(provider.sent).toHaveLength(0);
    expect(await reload(crashing.id)).toMatchObject({ status: 'FAILED', attempts: OUTBOX_MAX_ATTEMPTS + 1 });
  });

  it('si la cuenta se suprime mientras el mensaje se está enviando, el resultado no devuelve a la base el contenido ya vaciado', async () => {
    const { organization, initiative } = await scenario();
    const message = await queue(organization.id, initiative.id);
    const erasing: EmailProvider = {
      name: 'erasing',
      async send(sent) {
        // Lo que hace la supresión (erasure.service.ts) mientras el proveedor está trabajando.
        await db.outboxMessage.updateMany({ where: { id: message.id }, data: { status: 'CANCELLED', toAddress: 'suprimida-x@anonimizado.invalid', payloadJson: {} } });
        return { providerMessageId: `late-${sent.idempotencyKey}` };
      }
    };

    await dispatchOutbox(db, depsFor(async () => erasing), { now: NOW, limit: 10, ids: [message.id] });

    expect(await reload(message.id)).toMatchObject({ status: 'CANCELLED', toAddress: 'suprimida-x@anonimizado.invalid', payloadJson: {} });
  });

  it('un 401 de Brevo no destruye mensajes: esperan sin gastar intentos y se avisa como crítico', async () => {
    const { organization, initiative } = await scenario();
    const { BrevoEmailProvider } = await import('@/services/email/brevo-email-provider');
    const rejecting = new BrevoEmailProvider('k'.repeat(20), (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch);
    const message = await queue(organization.id, initiative.id);

    await dispatchOutbox(db, depsFor(async () => rejecting), { now: NOW, limit: 10, ids: [message.id] });

    expect(await reload(message.id)).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: 'email:configuration' } })).toMatchObject({ severity: 'CRITICAL', status: 'OPEN' });
  });
});

describe('QA-NOT02 · tarea OUTBOX_DISPATCH', () => {
  it('está registrada, figura en el calendario y se ejecuta con el procesador de la bandeja', async () => {
    expect(JOB_HANDLERS.OUTBOX_DISPATCH).toBe(outboxDispatchHandler);
    expect(JOB_SPECS.OUTBOX_DISPATCH.slug).toBe('outbox-dispatch');

    const { organization, initiative } = await scenario();
    const provider = new FakeProvider();
    const message = await queue(organization.id, initiative.id, { nextAttemptAt: new Date(Date.now() - MINUTE) });
    // La tarea envía todo lo pendiente del esquema compartido: lo que dejan otras suites (cientos de recibos y pases) se aplaza para que esta
    // prueba solo mida su propio mensaje y no agote su tiempo según el orden en que corran los archivos (Sprint 3.4).
    await db.outboxMessage.updateMany({ where: { status: 'PENDING', id: { not: message.id } }, data: { nextAttemptAt: new Date(Date.now() + 24 * 60 * MINUTE) } });
    const deps: JobDeps = {
      paymentProvider: () => Promise.reject(new Error('no se usa')),
      invoicingProvider: () => {
        throw new Error('no se usa');
      },
      refundOriginalIp: async () => '10.0.0.1',
      ...testJobDeps(),
      outbox: depsFor(async () => provider)
    };

    const executions = await runJob({ db, type: 'OUTBOX_DISPATCH', handler: outboxDispatchHandler, deps, now: new Date() });

    expect(executions.every((execution) => execution.outcome === 'DONE')).toBe(true);
    expect(await reload(message.id)).toMatchObject({ status: 'SENT' });
  });
});
