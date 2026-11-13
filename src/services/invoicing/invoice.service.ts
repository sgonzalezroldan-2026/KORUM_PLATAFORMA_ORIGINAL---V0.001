import { bpsOf } from '@/core/finance/money';
import { assertVerifiedSuperadmin, revalidateActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import type { Keyring } from '@/core/security/crypto';
import { validateTaxId } from '@/core/tax/tax-id';
import { openInvoiceRecipientTaxId, sealInvoiceRecipientTaxId } from '@/core/tax/tax-id-vault';
import { inTransaction, isRootDb, isUniqueViolation, QUEUED_TRANSACTION, type Db } from '@/lib/db';
import { InvoicingProviderError, type InvoicingProvider } from './invoicing-provider';
import { computeVerifactuHash, formatCents, generatedAtOf, invoiceYearOf, issueDateOf, verifactuQrUrl, type VerifactuRecord } from './verifactu-record';

/**
 * Facturas de KORUM (skill korum-escrow-payments §10, QA-REG02). La numeración y la huella se fijan dentro de una transacción con un bloqueo,
 * porque cada factura encadena con la anterior: dos a la vez se pondrían en cola. El proveedor se llama **después** de confirmar, para no
 * tener una conexión externa dentro de la transacción, y un resultado desconocido queda en `SENT` hasta que lo compruebe una persona.
 */

export interface IssueInvoiceInput {
  idempotencyKey: string;
  organizationId: string;
  issuerTaxId: string;
  /** Razón social del emisor: se guarda con la factura, que no cambia aunque cambie el ajuste de la consola. */
  issuerName?: string;
  recipientName: string;
  /** En claro solo en memoria: se guarda cifrado con el número de la factura como contexto. */
  recipientTaxId: string;
  /** Llavero con el que se cifra el NIF del destinatario. */
  keyring: Keyring;
  concept: string;
  baseAmountCents: number;
  taxRateBps: number;
  sponsorId?: number;
  payoutId?: number;
}

const INVOICE_TYPE = 'F1';
/** Rectificativa por error fundado en derecho (art. 80 LIVA): un patrocinio devuelto anula el servicio facturado. Serie propia (art. 15 RD 1619/2012). */
const RECTIFYING_TYPE = 'R1';

async function nextInvoiceNumber(tx: Db, year: number, series: 'FAC' | 'REC' = 'FAC'): Promise<string> {
  const prefix = `${series}-${year}-`;
  const latest = await tx.invoice.findFirst({ where: { invoiceNumber: { startsWith: prefix } }, orderBy: { id: 'desc' }, select: { invoiceNumber: true } });
  const sequence = latest ? Number(latest.invoiceNumber.slice(prefix.length)) + 1 : 1;
  if (!Number.isSafeInteger(sequence)) throw new Error(`Numeración de facturas ilegible tras ${latest?.invoiceNumber}.`);
  return `${prefix}${String(sequence).padStart(4, '0')}`;
}

/** Reconstruye el registro desde lo guardado: el mismo que se usó para calcular la huella. */
export function recordOfInvoice(
  invoice: { invoiceNumber: string; invoiceType?: string; taxAmountCents: number; totalAmountCents: number; prevVerifactuHash: string | null; issuedAt: Date },
  issuerTaxId: string
): VerifactuRecord {
  return {
    issuerTaxId,
    invoiceNumber: invoice.invoiceNumber,
    issueDate: issueDateOf(invoice.issuedAt),
    invoiceType: invoice.invoiceType ?? INVOICE_TYPE,
    taxTotal: formatCents(invoice.taxAmountCents),
    amountTotal: formatCents(invoice.totalAmountCents),
    previousHash: invoice.prevVerifactuHash,
    generatedAt: generatedAtOf(invoice.issuedAt)
  };
}

interface ChainedInvoice extends Omit<IssueInvoiceInput, 'recipientTaxId'> {
  /** NIF del destinatario ya validado y normalizado. */
  recipientTaxId: string;
  series: 'FAC' | 'REC';
  invoiceType: string;
  /** Importes ya calculados: negativos en una rectificativa por diferencias. */
  taxAmountCents: number;
  totalAmountCents: number;
  rectifiesInvoiceId?: number;
}

/** Escribe una factura al final de la cadena, con su número y su huella. Repetirla con la misma clave devuelve la misma factura. */
async function appendToChain(db: Db, input: ChainedInvoice, now: Date) {
  const existing = await db.invoice.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return existing;
  try {
    return await inTransaction(db, async (tx) => {
      // Una sola fila que todas las emisiones deben bloquear: la numeración y la cadena no admiten dos a la vez.
      await tx.globalConfig.update({ where: { id: 'GLOBAL' }, data: { updatedAt: new Date() } });
      const repeated = await tx.invoice.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (repeated) return repeated;

      const previous = await tx.invoice.findFirst({ orderBy: { id: 'desc' }, select: { verifactuHash: true, issuedAt: true } });
      // Se fija tras el bloqueo y nunca antes que la anterior: quien esperó turno en Nochevieja no queda detrás con un año pasado. En segundos,
      // porque la huella se debe poder recalcular con lo que queda guardado.
      const issuedAt = new Date(Math.max(Math.floor(now.getTime() / 1000) * 1000, previous?.issuedAt.getTime() ?? 0));
      const invoiceNumber = await nextInvoiceNumber(tx, invoiceYearOf(issuedAt), input.series);
      const { taxAmountCents, totalAmountCents, invoiceType } = input;
      const record = recordOfInvoice({ invoiceNumber, invoiceType, taxAmountCents, totalAmountCents, prevVerifactuHash: previous?.verifactuHash ?? null, issuedAt }, input.issuerTaxId);
      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber,
          series: input.series,
          invoiceType,
          rectifiesInvoiceId: input.rectifiesInvoiceId ?? null,
          idempotencyKey: input.idempotencyKey,
          organizationId: input.organizationId,
          sponsorId: input.sponsorId ?? null,
          payoutId: input.payoutId ?? null,
          recipientName: input.recipientName,
          issuerTaxId: input.issuerTaxId,
          issuerName: input.issuerName ?? null,
          ...sealInvoiceRecipientTaxId(input.keyring, invoiceNumber, input.recipientTaxId),
          concept: input.concept,
          baseAmountCents: input.baseAmountCents,
          taxRateBps: input.taxRateBps,
          taxAmountCents,
          totalAmountCents,
          prevVerifactuHash: record.previousHash,
          verifactuHash: computeVerifactuHash(record),
          verifactuQrUrl: verifactuQrUrl(record),
          verifactuStatus: 'PENDING',
          issuedAt
        }
      });
      await tx.auditLog.create({
        data: { actorType: 'SYSTEM', organizationId: input.organizationId, action: input.rectifiesInvoiceId ? 'invoice.rectified' : 'invoice.issued', targetType: 'Invoice', targetId: String(invoice.id), metadataJson: { invoiceNumber, totalAmountCents, rectifiesInvoiceId: input.rectifiesInvoiceId ?? null } }
      });
      return invoice;
    }, QUEUED_TRANSACTION);
  } catch (error) {
    // Dos llamadas con la misma clave a la vez: se devuelve la que ganó. Dentro de una transacción ajena la violación la aborta y no se puede consultar nada más en ella:
    // que lo reintente quien la abrió (al reintentar, la clave ya existe y devuelve la misma factura).
    if (!isUniqueViolation(error) || !isRootDb(db)) throw error;
    const winner = await db.invoice.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (!winner) throw error;
    return winner;
  }
}

/** Crea la factura en `PENDING`, con su número y su huella. Repetirla con la misma clave devuelve la misma factura. */
export async function issueInvoice(db: Db, input: IssueInvoiceInput, now: Date = new Date()) {
  if (!Number.isSafeInteger(input.baseAmountCents) || input.baseAmountCents <= 0) throw new RangeError('La base de la factura debe ser un importe positivo.');
  const recipient = validateTaxId(input.recipientTaxId);
  if (!recipient.valid) throw new RangeError('El NIF del destinatario de la factura no es válido.');
  const taxAmountCents = bpsOf(input.baseAmountCents, input.taxRateBps);
  return appendToChain(db, { ...input, recipientTaxId: recipient.normalized, series: 'FAC', invoiceType: INVOICE_TYPE, taxAmountCents, totalAmountCents: input.baseAmountCents + taxAmountCents }, now);
}

export class RectificationNotAllowedError extends Error {
  constructor(invoiceNumber: string, reason: string) {
    super(`La factura ${invoiceNumber} no se puede rectificar aquí: ${reason}.`);
    this.name = 'RectificationNotAllowedError';
  }
}

export interface RectifyInvoiceInput {
  invoiceId: number;
  /** NIF emisor vigente. La rectificativa la emite el mismo obligado que la original: si el NIF ha cambiado, no se emite (gestión manual). */
  issuerTaxId: string;
  /** Razón social vigente, para la rectificativa si la original no la guardó. */
  issuerName?: string;
  keyring: Keyring;
  /** Motivo, para el concepto de la rectificativa (sin datos personales). */
  concept: string;
}

/**
 * Rectificativa por diferencias de una factura completa: los mismos importes en negativo, de modo que la suma de ambas es cero. Va en su propia
 * serie (`REC-AAAA-NNNN`), apunta a la que corrige y entra en la misma cadena Veri*factu. Una factura se rectifica una sola vez: repetirlo
 * devuelve la misma rectificativa. El NIF del destinatario se descifra con la clave de la original y se vuelve a cifrar con el número nuevo.
 */
export async function rectifyInvoice(db: Db, input: RectifyInvoiceInput, now: Date = new Date()) {
  const original = await db.invoice.findUniqueOrThrow({ where: { id: input.invoiceId } });
  if (original.invoiceType !== INVOICE_TYPE || original.rectifiesInvoiceId !== null) throw new RangeError(`La factura ${original.invoiceNumber} no es una factura completa: no se rectifica.`);
  if (!original.recipientTaxIdEnc) throw new RangeError(`La factura ${original.invoiceNumber} no guarda el NIF del destinatario.`);
  if (original.issuerTaxId !== input.issuerTaxId) throw new RectificationNotAllowedError(original.invoiceNumber, 'el NIF emisor ha cambiado desde que se emitió');
  const recipientTaxId = openInvoiceRecipientTaxId(input.keyring, { invoiceNumber: original.invoiceNumber, recipientTaxIdEnc: original.recipientTaxIdEnc, recipientTaxIdKeyVersion: original.recipientTaxIdKeyVersion });
  return appendToChain(
    db,
    {
      idempotencyKey: `invoice:rectify:${original.id}`,
      organizationId: original.organizationId,
      issuerTaxId: original.issuerTaxId,
      issuerName: original.issuerName ?? input.issuerName,
      recipientName: original.recipientName,
      recipientTaxId,
      keyring: input.keyring,
      concept: `${input.concept} · Rectifica ${original.invoiceNumber}`.slice(0, 300),
      baseAmountCents: -original.baseAmountCents,
      taxRateBps: original.taxRateBps,
      taxAmountCents: -original.taxAmountCents,
      totalAmountCents: -original.totalAmountCents,
      series: 'REC',
      invoiceType: RECTIFYING_TYPE,
      rectifiesInvoiceId: original.id,
      ...(original.sponsorId === null ? {} : { sponsorId: original.sponsorId }),
      ...(original.payoutId === null ? {} : { payoutId: original.payoutId })
    },
    now
  );
}

export type SubmitInvoiceOutcome = 'ACCEPTED' | 'ACCEPTED_WITH_ERRORS' | 'REJECTED' | 'RETRY_LATER' | 'UNKNOWN' | 'ALREADY_SENT';

/** Envía una factura al proveedor. La reserva (`PENDING` → `SENT`) impide enviarla dos veces, igual que `refundSendingAt` en los reembolsos. */
export async function submitInvoice(db: Db, provider: InvoicingProvider, invoiceId: number, now: Date = new Date()): Promise<SubmitInvoiceOutcome> {
  const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (!invoice.issuerTaxId) throw new Error(`La factura ${invoice.invoiceNumber} no se emitió con este servicio.`);
  // La huella apunta a la factura anterior: enviarlas fuera de orden registraría una cadena que el proveedor aún no tiene.
  const earlier = await db.invoice.findFirst({ where: { id: { lt: invoiceId }, verifactuStatus: { in: ['PENDING', 'SENT'] } }, select: { id: true } });
  if (earlier && invoice.verifactuStatus === 'PENDING') return 'RETRY_LATER';
  const { count } = await db.invoice.updateMany({ where: { id: invoiceId, verifactuStatus: 'PENDING' }, data: { verifactuStatus: 'SENT', sentAt: now } });
  if (count === 0) return 'ALREADY_SENT';

  const audit = (action: string, code: string) => db.auditLog.create({ data: { actorType: 'SYSTEM', organizationId: invoice.organizationId, action, targetType: 'Invoice', targetId: String(invoiceId), metadataJson: { code } } });
  try {
    const result = await provider.registerInvoice(recordOfInvoice(invoice, invoice.issuerTaxId), invoice.verifactuHash);
    await db.invoice.update({ where: { id: invoiceId }, data: { verifactuStatus: result.status, providerReference: result.providerReference } });
    if (result.status !== 'ACCEPTED') await audit('invoice.registration_issue', result.status);
    return result.status;
  } catch (error) {
    if (!(error instanceof InvoicingProviderError)) throw error;
    if (error.outcomeUnknown) {
      await audit('invoice.registration_unknown', error.code);
      return 'UNKNOWN';
    }
    await db.invoice.update({ where: { id: invoiceId }, data: { verifactuStatus: 'PENDING', sentAt: null } });
    await audit('invoice.registration_retry', error.code);
    return 'RETRY_LATER';
  }
}

/** Envía en orden las pendientes (hasta `limit`) y se detiene en la primera que no pase. La ejecuta la tarea `INVOICE_SUBMIT`. */
export async function submitPendingInvoices(db: Db, provider: InvoicingProvider, options: { limit?: number; now?: Date; deadline?: number } = {}): Promise<{ submitted: number; stoppedAt: number | null }> {
  const pending = await db.invoice.findMany({ where: { verifactuStatus: 'PENDING' }, orderBy: { id: 'asc' }, take: options.limit, select: { id: true } });
  let submitted = 0;
  for (const { id } of pending) {
    // Sin tiempo para otra llamada al proveedor: cortar una a medias deja la factura en `SENT` y obliga a resolverla a mano.
    if (options.deadline !== undefined && Date.now() > options.deadline) return { submitted, stoppedAt: null };
    const outcome = await submitInvoice(db, provider, id, options.now);
    if (outcome === 'RETRY_LATER' || outcome === 'UNKNOWN') return { submitted, stoppedAt: id };
    submitted += 1;
  }
  return { submitted, stoppedAt: null };
}

export class InvoiceNotAllowedError extends Error {
  constructor(invoiceId: number, reason: string) {
    super(`La factura ${invoiceId} no se puede resolver: ${reason}.`);
    this.name = 'InvoiceNotAllowedError';
  }
}

export type UnknownInvoiceResolution =
  /** El proveedor no la tiene: vuelve a la cola de envío. */
  | { registered: false }
  /** El proveedor la tiene, con este estado y esta referencia. */
  | { registered: true; status: 'ACCEPTED' | 'ACCEPTED_WITH_ERRORS' | 'REJECTED'; providerReference: string | null };

/**
 * Resuelve una factura de resultado desconocido, cuando una persona (solo un Super-Admin verificado, `VerifiedSuperadminActor`) ya ha comprobado en el
 * proveedor qué pasó. Mientras una esté en `SENT`, el envío de todas las siguientes se detiene. Queda en la auditoría.
 */
export async function resolveUnknownInvoice(db: Db, actor: VerifiedSuperadminActor, invoiceId: number, resolution: UnknownInvoiceResolution, now: Date = new Date()): Promise<void> {
  assertVerifiedSuperadmin(actor, 'invoice.resolve_unknown', now);
  await inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'invoice.resolve_unknown', now);
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { organizationId: true } });
    const data = resolution.registered ? { verifactuStatus: resolution.status, providerReference: resolution.providerReference } : { verifactuStatus: 'PENDING' as const, sentAt: null };
    const { count } = await tx.invoice.updateMany({ where: { id: invoiceId, verifactuStatus: 'SENT' }, data });
    if (count === 0) throw new InvoiceNotAllowedError(invoiceId, 'no está pendiente de resolver');
    await tx.auditLog.create({
      data: { actorType: 'USER', actorUserId: actor.userId, organizationId: invoice.organizationId, action: 'invoice.registration_resolved', targetType: 'Invoice', targetId: String(invoiceId), metadataJson: { registered: resolution.registered } }
    });
  });
}

export interface ChainCheck {
  checked: number;
  brokenLinks: string[];
  /** Huella distinta de la que da el registro. Las facturas de demostración de la semilla no llevan NIF emisor ni huella oficial: no se recalculan. */
  wrongHashes: string[];
}

const OFFICIAL_HASH = /^[0-9A-F]{64}$/;

/** Recorre la cadena: cada factura debe apuntar a la anterior, y su huella debe salir de sus propios datos. */
export async function verifyInvoiceChain(db: Db): Promise<ChainCheck> {
  const invoices = await db.invoice.findMany({ orderBy: { id: 'asc' } });
  const result: ChainCheck = { checked: invoices.length, brokenLinks: [], wrongHashes: [] };
  let previousHash: string | null = null;
  for (const invoice of invoices) {
    if (invoice.prevVerifactuHash !== previousHash) result.brokenLinks.push(invoice.invoiceNumber);
    if (invoice.issuerTaxId && OFFICIAL_HASH.test(invoice.verifactuHash) && computeVerifactuHash(recordOfInvoice(invoice, invoice.issuerTaxId)) !== invoice.verifactuHash) result.wrongHashes.push(invoice.invoiceNumber);
    previousHash = invoice.verifactuHash;
  }
  return result;
}
