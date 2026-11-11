import type { ProviderPayoutBeneficiary } from '@/core/payouts/provider-fields';
/**
 * Contrato con la entidad de pago (Regla 01 §3). El resto de la aplicación solo conoce esta interfaz, así que se puede cambiar de
 * proveedor sin tocar nada más. Todos los importes van en céntimos enteros.
 *
 * El dinero solo sale de dos formas, y ninguna admite un destino libre: el reembolso vuelve al cobro original (`order` + `authCode`) y
 * el reparto va a la cuenta destino de una entidad ya verificada (`splitId`). No existe ningún método que reciba un IBAN (QA-P02).
 */

export type PaymentMode = 'mock' | 'sandbox' | 'live';
export type ChargeMethod = 'CARD' | 'BIZUM' | 'APPLE_PAY' | 'GOOGLE_PAY';

export interface ChargeRequest {
  order: string;
  amountCents: number;
  method: ChargeMethod;
  originalIp: string;
  /** Token de la tarjeta guardada o recién tokenizada. Obligatorio en todo lo que no sea Bizum. */
  card?: { idUser: number; tokenUser: string };
  description?: string;
  /**
   * Cobro iniciado por KORUM sin la persona delante (cada mes de Mi Hucha), con la tarjeta que guardó en un primer pago autenticado. Va como
   * operación recurrente exenta de autenticación reforzada (MIT). **A confirmar con Paycomet** (CUMPLIMIENTO §2, punto 6).
   */
  merchantInitiated?: boolean;
}

export interface ChargeResult {
  order: string;
  authCode: string | null;
  /** Página de autenticación reforzada o de confirmación de Bizum, si el cobro la necesita. El resultado llega por webhook. */
  challengeUrl: string | null;
}

/**
 * Pago de una familia en la página segura de la entidad de pago (checkout, Sprint 3.4): KORUM nunca ve la tarjeta. La persona vuelve a
 * `urlOk` o `urlKo`, pero lo que cuenta es el webhook: la vuelta solo enseña el estado que ya está guardado.
 */
export interface HostedPaymentRequest {
  order: string;
  amountCents: number;
  method: Extract<ChargeMethod, 'CARD' | 'BIZUM'>;
  originalIp: string;
  locale: 'es' | 'ca' | 'en';
  urlOk: string;
  urlKo: string;
  description?: string;
  /**
   * Primer pago de una aportación mensual: Paycomet guarda la tarjeta para los meses siguientes y la notificación del cobro trae su token
   * (`IdUser` + `TokenUser`). Solo con tarjeta: Bizum no se puede guardar.
   */
  saveCard?: boolean;
}

export interface HostedPaymentResult {
  order: string;
  /** Página de pago a la que se envía a la persona. `null` en el simulador, que tiene su propia página dentro de KORUM. */
  challengeUrl: string | null;
}

export interface TokenizeRequest {
  /** Token de un solo uso del formulario de tarjeta (JET-ID): KORUM nunca ve ni guarda el número de la tarjeta. */
  jetToken: string;
}

export interface TokenizeResult {
  idUser: number;
  tokenUser: string;
}

export interface RefundRequest {
  order: string;
  authCode: string;
  amountCents: number;
  originalIp: string;
}

export interface RefundResult {
  authCode: string | null;
}

export interface SplitTransferRequest {
  /** Cobro original del que sale el reparto: Paycomet reparte cobro a cobro, no sobre un saldo global. */
  order: string;
  authCode: string;
  splitId: string;
  amountCents: number;
}

export interface SplitTransferResult {
  splitAuthCode: string;
}

/** Un cobro confirmado tal y como lo ve Paycomet, para la conciliación diaria. */
export interface PspCharge {
  order: string;
  amountCents: number;
  authCode: string | null;
  occurredAt: Date;
}

export type PaymentNotificationKind = 'PAYMENT_COMPLETED' | 'PAYMENT_FAILED' | 'REFUND_COMPLETED' | 'REFUND_FAILED' | 'CHARGEBACK' | 'IGNORED';

/** Notificación de la entidad de pago, ya con su firma comprobada. */
export interface PaymentNotification {
  externalEventId: string;
  kind: PaymentNotificationKind;
  order: string;
  amountCents: number;
  currency: string;
  authCode: string | null;
  occurredAt: Date | null;
  /** Solo campos de la operación: nunca el token de la tarjeta ni datos de quien paga. Es lo que se guarda en `WebhookEvent`. */
  payload: Record<string, string>;
  /**
   * Tarjeta guardada en un pago con `saveCard`. Nunca entra en `payload` (no se guarda en claro): quien la recibe la cifra en el acto. Paycomet
   * no incluye estos campos en la firma; una entrega repetida con otro token es un duplicado y no se procesa.
   */
  card?: { idUser: number; tokenUser: string; brand: string | null } | null;
}

export type NotificationCheck = { valid: true; notification: PaymentNotification } | { valid: false; reason: string };

export interface PaymentProvider {
  readonly mode: PaymentMode;
  readonly name: string;
  charge(request: ChargeRequest): Promise<ChargeResult>;
  startHostedPayment(request: HostedPaymentRequest): Promise<HostedPaymentResult>;
  tokenizeCard(request: TokenizeRequest): Promise<TokenizeResult>;
  /** Borra una tarjeta guardada en el proveedor (supresión de la cuenta). Borrar una que ya no existe no es un error. */
  deleteCard(card: TokenizeResult): Promise<void>;
  refund(request: RefundRequest): Promise<RefundResult>;
  splitTransfer(request: SplitTransferRequest): Promise<SplitTransferResult>;
  /**
   * Cuenta de Paycomet a la que repartir para pagar directamente al proveedor que eligió la entidad (Sprint 4.4a). **Pendiente de Paycomet** (tarea
   * aplazada): solo el simulador lo ofrece, con una cuenta simulada y no verificada; sin este método, el pago al proveedor no aparece en el panel.
   */
  providerPayoutAccount?(beneficiary: ProviderPayoutBeneficiary): Promise<string>;
  /** Cobros confirmados con `occurredAt` en `[from, to]`. Lanza si el proveedor no puede devolverlos todos: una lista recortada falsearía la conciliación. */
  listCharges(range: { from: Date; to: Date }): Promise<PspCharge[]>;
  verifyNotification(rawBody: string, contentType: string | null): NotificationCheck;
}

export class PaymentProviderError extends Error {
  readonly code: string;
  /**
   * `true` si no se sabe si la operación se hizo (se cortó la conexión): nunca se reintenta a ciegas, porque podría mover dinero dos
   * veces. Hay que comprobarlo antes en el proveedor.
   */
  readonly outcomeUnknown: boolean;

  constructor(message: string, code: string, outcomeUnknown = false) {
    super(message);
    this.name = 'PaymentProviderError';
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}
