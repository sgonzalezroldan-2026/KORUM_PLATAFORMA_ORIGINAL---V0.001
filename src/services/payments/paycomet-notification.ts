import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { NotificationCheck, PaymentNotificationKind } from './payment-provider';

/**
 * Notificaciones de Paycomet (docs.paycomet.com/en/inicio/seguimiento, consultado en octubre de 2026). Funciones puras, compartidas
 * por el adaptador real y por el simulador: así el simulador firma exactamente igual que Paycomet.
 *
 * Firma: SHA-512 de AccountCode + TpvID + TransactionType + Order + Amount + Currency + md5(contraseña) + BankDateTime + Response.
 * Suposiciones a confirmar con Paycomet (la documentación no las aclara): el formato del cuerpo (se aceptan formulario y JSON), que
 * el valor de fallo de `Response` es distinto de `OK`, y que BankDateTime llega en hora UTC.
 */

export interface NotificationSecrets {
  accountCode: string;
  terminal: string;
  /** Contraseña del producto en Paycomet (ajuste `paycomet.webhookSecret`). */
  password: string;
}

const TRANSACTION_AUTHORIZATION = '1';
const TRANSACTION_REFUND = '2';
const TRANSACTION_CHARGEBACK = '106';

/** Texto o número, según venga en formulario o en JSON. Nada de `null`, listas ni objetos convertidos a texto. */
const scalar = z.union([z.string(), z.number()]).transform(String);
/**
 * Los campos que NO entran en la firma: con formato estricto. Uno vacío, nulo o con otro formato cuenta como ausente, en vez de rechazar la
 * notificación: Paycomet no ha confirmado su formato, y perder un cobro auténtico sin rastro sería peor. Un cobro sin `AuthCode` falla después, con rastro.
 */
const unsigned = (pattern: RegExp) => scalar.pipe(z.string().regex(pattern)).optional().catch(undefined);

const fieldsSchema = z.object({
  AccountCode: z.string().min(1).max(32),
  TpvID: scalar.pipe(z.string().min(1).max(16)),
  TransactionType: scalar.pipe(z.string().regex(/^\d{1,5}$/)),
  Order: z.string().min(1).max(70),
  Amount: scalar.pipe(z.string().regex(/^\d{1,15}$/)),
  Currency: z.string().min(1).max(8),
  BankDateTime: scalar.pipe(z.string().max(32)),
  Response: z.string().max(16),
  NotificationHash: z.string().regex(/^[0-9a-fA-F]{128}$/),
  AuthCode: unsigned(/^[\x21-\x7e]{1,40}$/),
  ErrorID: unsigned(/^\d{1,10}$/),
  MethodId: unsigned(/^\d{1,5}$/),
  paycometId: unsigned(/^\d{1,20}$/),
  // Tarjeta guardada (primer pago de Mi Hucha). No entran en `payload`: se cifran al recibirlos.
  IdUser: unsigned(/^[1-9]\d{0,11}$/),
  TokenUser: unsigned(/^[!-~]{1,64}$/),
  CardBrand: unsigned(/^[A-Za-z0-9 _-]{1,30}$/)
});

export type NotificationFields = z.output<typeof fieldsSchema>;
type SignedFields = Pick<NotificationFields, 'TransactionType' | 'Order' | 'Amount' | 'Currency' | 'BankDateTime' | 'Response'>;

export function notificationHash(fields: SignedFields, secrets: NotificationSecrets): string {
  const passwordMd5 = createHash('md5').update(secrets.password).digest('hex');
  const material = secrets.accountCode + secrets.terminal + fields.TransactionType + fields.Order + fields.Amount + fields.Currency + passwordMd5 + fields.BankDateTime + fields.Response;
  return createHash('sha512').update(material).digest('hex');
}

function parseBody(rawBody: string, contentType: string | null): unknown {
  if (contentType?.toLowerCase().includes('json')) {
    try {
      return JSON.parse(rawBody);
    } catch {
      return null;
    }
  }
  return Object.fromEntries(new URLSearchParams(rawBody));
}

function kindOf(fields: NotificationFields): PaymentNotificationKind {
  const ok = fields.Response === 'OK';
  if (fields.TransactionType === TRANSACTION_AUTHORIZATION) return ok ? 'PAYMENT_COMPLETED' : 'PAYMENT_FAILED';
  if (fields.TransactionType === TRANSACTION_REFUND) return ok ? 'REFUND_COMPLETED' : 'REFUND_FAILED';
  // Un contracargo saca dinero de una hucha: si no viene confirmado, no se aplica.
  if (fields.TransactionType === TRANSACTION_CHARGEBACK) return ok ? 'CHARGEBACK' : 'IGNORED';
  return 'IGNORED';
}

/** Admite `YYYYMMDDHHmmss` e ISO. Solo sirve para fechar el asiento: si no se entiende, quien llama usa la hora de recepción. */
function parseBankDate(value: string): Date | null {
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  const parsed = compact ? new Date(`${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`) : new Date(value.includes(' ') ? `${value.replace(' ', 'T')}Z` : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function verifyPaycometNotification(rawBody: string, contentType: string | null, secrets: NotificationSecrets): NotificationCheck {
  const parsed = fieldsSchema.safeParse(parseBody(rawBody, contentType));
  if (!parsed.success) return { valid: false, reason: 'MALFORMED' };
  const fields = parsed.data;

  const expected = Buffer.from(notificationHash(fields, secrets), 'hex');
  const received = Buffer.from(fields.NotificationHash, 'hex');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return { valid: false, reason: 'BAD_SIGNATURE' };
  // La firma incluye estos dos valores, pero la de otro producto de la misma cuenta también sería correcta para su propia contraseña.
  if (fields.AccountCode !== secrets.accountCode || fields.TpvID !== secrets.terminal) return { valid: false, reason: 'WRONG_TERMINAL' };

  const { TransactionType, Order, Amount, Currency, BankDateTime, Response, AuthCode, ErrorID, MethodId, paycometId, IdUser, TokenUser, CardBrand } = fields;
  const payload: Record<string, string> = { TransactionType, Order, Amount, Currency, BankDateTime, Response };
  for (const [key, value] of Object.entries({ AuthCode, ErrorID, MethodId, paycometId })) {
    if (value !== undefined) payload[key] = value;
  }
  const amountCents = Number(Amount);
  if (!Number.isSafeInteger(amountCents)) return { valid: false, reason: 'MALFORMED' };

  return {
    valid: true,
    notification: {
      // Solo con campos firmados: quien capture una notificación no puede fabricar identificadores nuevos cambiando los demás.
      externalEventId: `${TransactionType}:${createHash('sha256').update([TransactionType, Order, Amount, Currency, BankDateTime, Response].join('|')).digest('hex')}`,
      kind: kindOf(fields),
      order: Order,
      amountCents,
      currency: Currency,
      authCode: AuthCode ?? null,
      occurredAt: parseBankDate(BankDateTime),
      payload,
      card: IdUser && TokenUser ? { idUser: Number(IdUser), tokenUser: TokenUser, brand: CardBrand ?? null } : null
    }
  };
}
