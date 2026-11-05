import { raiseAlert } from '@/core/jobs/ops-alerts';
import type { Prisma } from '@/generated/prisma/client';
import type { Db } from '@/lib/db';
import { redactText } from '@/lib/redact';
import { EmailConfigurationError, EmailSendError, type EmailProvider } from './email-provider';
import { EmailContextError, loadEmailContext } from './outbox-context';
import { isUndeliverableAddress, scrubSecrets, secretsExpired } from './outbox-secrets';
import { renderEmail, UnknownTemplateError } from './render-email';
import type { EmailSender } from './provider-factory';
import { InvalidPayloadError, secretFieldsOf, TEMPLATE_CATALOG } from './templates/catalog';

/**
 * Procesador de la bandeja de salida (`OutboxMessage`). Cada mensaje:
 *   1. se reclama con una actualización condicional (`PENDING` → `SENDING`, con un plazo de reserva): dos servidores a la vez nunca envían
 *      el mismo mensaje, y uno reservado por una caída se recupera cuando vence la reserva;
 *   2. se descarta sin enviar si ya no tiene destinatario real (cuenta suprimida) o si su enlace o código caducó;
 *   3. se compone con su plantilla, en el idioma del mensaje, y se envía;
 *   4. queda `SENT`, o se reintenta con espera creciente, o queda `FAILED` y abre una alerta para el Super-Admin.
 * El envío es «al menos una vez»: si el proveedor acepta el mensaje y el servidor cae antes de anotarlo, se reenviará al vencer la reserva.
 * Los enlaces y códigos de un solo uso se borran del mensaje en cuanto sale, se cancela o falla.
 */

export const OUTBOX_MAX_ATTEMPTS = 6;
/** Espera tras cada intento fallido (el primero es el índice 0). */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
/** Cuánto dura la reserva de un mensaje: pasado este tiempo, otro proceso puede reclamarlo. */
export const OUTBOX_LEASE_MS = 10 * 60_000;
/** Si el proveedor no está configurado, se vuelve a mirar pasado este tiempo. */
const CONFIGURATION_RETRY_MS = 15 * 60_000;
const MAX_ERROR_LENGTH = 300;

export const retryDelayMs = (attempt: number): number => RETRY_DELAYS_MS[Math.min(Math.max(attempt, 1), RETRY_DELAYS_MS.length) - 1]!;

export interface OutboxDeps {
  provider: () => Promise<EmailProvider>;
  sender: () => Promise<EmailSender | undefined>;
  /** URL canónica pública (`NEXT_PUBLIC_APP_URL`). */
  appUrl: () => string;
  /** `QR_HMAC_SECRET`, para componer el QR de las entradas. */
  qrSecret: () => string;
}

export interface DispatchOptions {
  now?: Date;
  /** Mensajes que se atienden como máximo en esta llamada. */
  limit: number;
  /** Instante (ms desde 1970) pasado el cual no se empiezan envíos nuevos. */
  deadline?: number;
  /** Limita el envío a estos mensajes (los que acaba de escribir quien llama). Sin esto, se atiende toda la bandeja. */
  ids?: readonly number[];
}

export interface DispatchResult {
  processed: number;
  sent: number;
  retried: number;
  failed: number;
  cancelled: number;
  /** Quedan mensajes listos para enviar. */
  hasMore: boolean;
}

const describeError = (error: unknown): string => redactText(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, MAX_ERROR_LENGTH);

const ready = (now: Date, ids?: readonly number[]): Prisma.OutboxMessageWhereInput => ({
  channel: 'EMAIL',
  ...(ids ? { id: { in: [...ids] } } : {}),
  OR: [
    { status: 'PENDING', nextAttemptAt: { lte: now } },
    // Reservado por un proceso que no terminó (caída): la reserva venció y se puede recuperar.
    { status: 'SENDING', nextAttemptAt: { lte: now } }
  ]
});

async function claim(db: Db, id: number, now: Date, ids?: readonly number[]) {
  const { count } = await db.outboxMessage.updateMany({
    where: { ...ready(now, ids), id },
    data: { status: 'SENDING', attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + OUTBOX_LEASE_MS) }
  });
  if (count !== 1) return null;
  return db.outboxMessage.findUniqueOrThrow({ where: { id } });
}

type Row = NonNullable<Awaited<ReturnType<typeof claim>>>;

async function finish(db: Db, row: Row, data: Prisma.OutboxMessageUpdateManyMutationInput): Promise<void> {
  // Solo si seguimos siendo quien lo tiene reservado: si la reserva venció y otro lo tomó, no se pisa su resultado.
  await db.outboxMessage.updateMany({ where: { id: row.id, status: 'SENDING', attempts: row.attempts }, data: { ...data, ...(secretFieldsOf(row.templateKey).length > 0 ? { payloadJson: scrubSecrets(row.templateKey, row.payloadJson) as Prisma.InputJsonValue } : {}) } });
}

async function alertDelivery(db: Db, now: Date, dedupeKey: string, severity: 'WARNING' | 'CRITICAL', detail: Prisma.InputJsonObject): Promise<void> {
  // El detalle lleva claves técnicas y recuentos, nunca direcciones de email.
  await raiseAlert(db, { type: 'EMAIL_DELIVERY_FAILED', severity, dedupeKey, detail }, now);
}

type Outcome = 'sent' | 'retried' | 'failed' | 'cancelled' | 'deferred';

async function deliver(db: Db, deps: OutboxDeps, row: Row, now: Date): Promise<Outcome> {
  // Un mensaje que tumba el proceso al componerse se reclama una y otra vez: al pasar el máximo se da por fallido en lugar de insistir.
  if (row.attempts > OUTBOX_MAX_ATTEMPTS) {
    await finish(db, row, { status: 'FAILED', lastError: 'Superó el máximo de intentos sin llegar a completarse.' });
    await alertDelivery(db, now, `email:failed:${row.templateKey}`, 'WARNING', { templateKey: row.templateKey, reason: 'crashed', lastMessageId: row.id });
    return 'failed';
  }
  if (row.userId && (await db.user.findUnique({ where: { id: row.userId }, select: { gdprAnonymizedAt: true } }))?.gdprAnonymizedAt) {
    await finish(db, row, { status: 'CANCELLED', lastError: null });
    return 'cancelled';
  }
  if (isUndeliverableAddress(row.toAddress)) {
    await finish(db, row, { status: 'CANCELLED', lastError: null });
    return 'cancelled';
  }
  if (secretsExpired(row, now)) {
    await finish(db, row, { status: 'CANCELLED', lastError: 'El enlace o código caducó antes de poder enviarse.' });
    return 'cancelled';
  }

  const template = TEMPLATE_CATALOG.get(row.templateKey);
  try {
    if (!template) throw new UnknownTemplateError(row.templateKey);
    const context = await loadEmailContext(db, row, template.needs);
    const rendered = await renderEmail({
      templateKey: row.templateKey,
      locale: row.locale,
      payload: row.payloadJson,
      createdAt: row.createdAt,
      appUrl: deps.appUrl(),
      qrSecret: deps.qrSecret(),
      ...(context.organization ? { organization: context.organization } : {}),
      ...(context.initiative ? { initiative: context.initiative } : {})
    });
    const sender = await deps.sender();
    if (!sender) throw new EmailConfigurationError(['email.fromAddress']);
    const provider = await deps.provider();
    const result = await provider.send({
      to: row.toAddress,
      fromAddress: sender.fromAddress,
      fromName: rendered.senderName ?? sender.fromName,
      ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      attachments: rendered.attachments,
      idempotencyKey: row.idempotencyKey
    });
    await finish(db, row, { status: 'SENT', sentAt: now, providerMessageId: result.providerMessageId, lastError: null });
    return 'sent';
  } catch (error) {
    // Fallos nuestros (plantilla desconocida, datos que no cuadran) o rechazo definitivo del proveedor: reintentar no los arregla.
    const permanent = error instanceof UnknownTemplateError || error instanceof InvalidPayloadError || error instanceof EmailContextError || (error instanceof EmailSendError && error.permanent);
    if (error instanceof EmailConfigurationError) {
      // No es culpa del mensaje: se devuelve a la cola sin gastar el intento y se avisa al Super-Admin.
      await db.outboxMessage.updateMany({ where: { id: row.id, status: 'SENDING', attempts: row.attempts }, data: { status: 'PENDING', attempts: { decrement: 1 }, nextAttemptAt: new Date(now.getTime() + CONFIGURATION_RETRY_MS), lastError: describeError(error) } });
      await alertDelivery(db, now, 'email:configuration', 'CRITICAL', { reason: 'configuration' });
      return 'deferred';
    }
    if (permanent || row.attempts >= OUTBOX_MAX_ATTEMPTS) {
      await finish(db, row, { status: 'FAILED', lastError: describeError(error) });
      await alertDelivery(db, now, `email:failed:${row.templateKey}`, 'WARNING', { templateKey: row.templateKey, reason: permanent ? 'permanent' : 'attempts-exhausted', lastMessageId: row.id });
      return 'failed';
    }
    await db.outboxMessage.updateMany({ where: { id: row.id, status: 'SENDING', attempts: row.attempts }, data: { status: 'PENDING', nextAttemptAt: new Date(now.getTime() + retryDelayMs(row.attempts)), lastError: describeError(error) } });
    return 'retried';
  }
}

/** Envía los mensajes de la bandeja que ya tocan. Segura para llamarla a la vez desde el webhook y desde la tarea programada. */
export async function dispatchOutbox(db: Db, deps: OutboxDeps, options: DispatchOptions): Promise<DispatchResult> {
  const now = options.now ?? new Date();
  const candidates = await db.outboxMessage.findMany({ where: ready(now, options.ids), orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: options.limit + 1, select: { id: true } });
  const result: DispatchResult = { processed: 0, sent: 0, retried: 0, failed: 0, cancelled: 0, hasMore: candidates.length > options.limit };

  for (const { id } of candidates.slice(0, options.limit)) {
    if (options.deadline !== undefined && Date.now() > options.deadline) {
      result.hasMore = true;
      break;
    }
    const row = await claim(db, id, now, options.ids);
    if (!row) continue;
    const outcome = await deliver(db, deps, row, now);
    if (outcome === 'deferred') {
      // Sin configuración, el resto fallaría igual: se para y se vuelve a mirar más tarde.
      result.hasMore = false;
      break;
    }
    result.processed += 1;
    result[outcome] += 1;
  }
  return result;
}
