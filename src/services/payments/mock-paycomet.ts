import { createHash } from 'node:crypto';
import { SPLIT_WINDOW_DAYS } from '@/core/finance/campaign-window';
import type { ProviderPayoutBeneficiary } from '@/core/payouts/provider-fields';
import { notificationHash, verifyPaycometNotification, type NotificationSecrets } from './paycomet-notification';
import {
  PaymentProviderError,
  type ChargeRequest,
  type ChargeResult,
  type HostedPaymentRequest,
  type HostedPaymentResult,
  type NotificationCheck,
  type PaymentProvider,
  type PspCharge,
  type RefundRequest,
  type RefundResult,
  type SplitTransferRequest,
  type SplitTransferResult,
  type TokenizeRequest,
  type TokenizeResult
} from './payment-provider';

/**
 * Simulador local de Paycomet (`PAYCOMET_MODE=mock`): sin red y determinista. Firma las notificaciones con la fórmula real y aplica
 * las restricciones conocidas: no se devuelve ni se reparte más de lo cobrado, y no se reparte pasados 90 días desde el cobro.
 * Solo conoce los cobros que ha hecho él; los de la semilla se registran con `registerCharge` o se aceptan sin esos límites.
 */

const TRANSACTION_TYPE = { PAYMENT: '1', REFUND: '2', CHARGEBACK: '106' } as const;
const DAY_MS = 86_400_000;

type MockFailure = PaymentProviderError | ((request: string) => PaymentProviderError | null);

export interface MockPaycometOptions {
  secrets: NotificationSecrets;
  now?: () => Date;
  /** Fuerza un fallo en una operación, para probar reintentos y cortes de conexión. */
  failRefund?: MockFailure;
  failSplit?: MockFailure;
  failDeleteCard?: MockFailure;
  /** Fuerza un fallo en un cobro con tarjeta guardada (Mi Hucha). */
  failCharge?: MockFailure;
}

interface MockCharge {
  amountCents: number;
  authCode: string;
  chargedAt: Date;
  refundedCents: number;
  splitCents: number;
}

const stableCode = (prefix: string, text: string) => `${prefix}${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;

export class MockPaycometProvider implements PaymentProvider {
  readonly mode = 'mock' as const;
  readonly name = 'paycomet';
  readonly calls: Array<{ operation: 'charge' | 'hosted' | 'refund' | 'split'; order: string; amountCents: number; authCode?: string; splitId?: string }> = [];
  /** Tarjetas cuyo borrado se ha pedido (`idUser`). */
  readonly deletedCards: number[] = [];
  private readonly charges = new Map<string, MockCharge>();
  private readonly now: () => Date;

  constructor(private readonly options: MockPaycometOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Da de alta un cobro en el simulador. `authCode` permite fabricar una diferencia con lo guardado en KORUM (pruebas de conciliación). */
  registerCharge(order: string, amountCents: number, chargedAt: Date = this.now(), authCode: string = stableCode('A', order)): void {
    this.charges.set(order, { amountCents, authCode, chargedAt, refundedCents: 0, splitCents: 0 });
  }

  /** Quita un cobro del simulador, como si Paycomet no lo tuviera (pruebas de conciliación). */
  forgetCharge(order: string): void {
    this.charges.delete(order);
  }

  async listCharges(range: { from: Date; to: Date }): Promise<PspCharge[]> {
    return [...this.charges]
      .filter(([, charge]) => charge.chargedAt >= range.from && charge.chargedAt <= range.to)
      .map(([order, charge]) => ({ order, amountCents: charge.amountCents, authCode: charge.authCode, occurredAt: charge.chargedAt }));
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    if (request.method !== 'BIZUM' && !request.card) throw new PaymentProviderError('Un cobro con tarjeta necesita su token', 'MOCK_NO_CARD');
    this.throwIfFailing(this.options.failCharge, request.order);
    this.calls.push({ operation: 'charge', order: request.order, amountCents: request.amountCents });
    this.registerCharge(request.order, request.amountCents);
    return { order: request.order, authCode: this.charges.get(request.order)?.authCode ?? null, challengeUrl: null };
  }

  /**
   * Sin página externa: el checkout lleva a la persona al simulador de KORUM (`/aportar/simulador`), donde confirma o rechaza el pago. El
   * cobro solo existe en el simulador cuando se confirma (`buildNotification` con `OK`).
   */
  async startHostedPayment(request: HostedPaymentRequest): Promise<HostedPaymentResult> {
    this.calls.push({ operation: 'hosted', order: request.order, amountCents: request.amountCents });
    return { order: request.order, challengeUrl: null };
  }

  async tokenizeCard(request: TokenizeRequest): Promise<TokenizeResult> {
    const digest = createHash('sha256').update(request.jetToken).digest();
    return { idUser: digest.readUInt32BE(0), tokenUser: digest.subarray(4, 20).toString('hex') };
  }

  async deleteCard(card: TokenizeResult): Promise<void> {
    this.throwIfFailing(this.options.failDeleteCard, String(card.idUser));
    this.deletedCards.push(card.idUser);
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    this.throwIfFailing(this.options.failRefund, request.order);
    const charge = this.charges.get(request.order);
    if (charge) {
      if (charge.refundedCents + request.amountCents > charge.amountCents) throw new PaymentProviderError('El reembolso supera lo cobrado', 'MOCK_REFUND_EXCEEDS_CHARGE');
      charge.refundedCents += request.amountCents;
    }
    this.calls.push({ operation: 'refund', order: request.order, amountCents: request.amountCents, authCode: request.authCode });
    return { authCode: stableCode('R', request.order) };
  }

  async splitTransfer(request: SplitTransferRequest): Promise<SplitTransferResult> {
    this.throwIfFailing(this.options.failSplit, request.order);
    const charge = this.charges.get(request.order);
    if (charge) {
      if ((this.now().getTime() - charge.chargedAt.getTime()) / DAY_MS > SPLIT_WINDOW_DAYS) throw new PaymentProviderError('Han pasado más de 90 días desde el cobro', 'MOCK_SPLIT_WINDOW');
      if (charge.splitCents + request.amountCents > charge.amountCents) throw new PaymentProviderError('El reparto supera lo cobrado', 'MOCK_SPLIT_EXCEEDS_CHARGE');
      charge.splitCents += request.amountCents;
    }
    this.calls.push({ operation: 'split', order: request.order, amountCents: request.amountCents, authCode: request.authCode, splitId: request.splitId });
    return { splitAuthCode: stableCode('S', `${request.order}:${request.splitId}`) };
  }

  /** Cuenta simulada del proveedor: estable para un mismo IBAN y CIF, y marcada como no verificada ('MOCK-PRV-'). */
  async providerPayoutAccount(beneficiary: ProviderPayoutBeneficiary): Promise<string> {
    return stableCode('MOCK-PRV-', JSON.stringify(beneficiary));
  }

  verifyNotification(rawBody: string, contentType: string | null): NotificationCheck {
    return verifyPaycometNotification(rawBody, contentType, this.options.secrets);
  }

  /** Tarjeta que «guarda» el simulador en el primer pago de Mi Hucha: determinista por pedido, como la tokenización. */
  savedCardFor(order: string): { idUser: number; tokenUser: string; brand: string } {
    const digest = createHash('sha256').update(`saved-card:${order}`).digest();
    return { idUser: (digest.readUInt32BE(0) % 900_000_000) + 1, tokenUser: digest.subarray(4, 20).toString('hex'), brand: 'VISA' };
  }

  /** La notificación que enviaría Paycomet, ya firmada: el cuerpo y su tipo, listos para entregar al webhook. Con `card`, la de un pago que guarda la tarjeta. */
  buildNotification(input: {
    kind: keyof typeof TRANSACTION_TYPE;
    order: string;
    amountCents: number;
    response?: 'OK' | 'KO';
    authCode?: string;
    bankDateTime?: string;
    card?: { idUser: number; tokenUser: string; brand: string };
  }) {
    const fields = {
      TransactionType: TRANSACTION_TYPE[input.kind],
      Order: input.order,
      Amount: String(input.amountCents),
      Currency: 'EUR',
      BankDateTime: input.bankDateTime ?? '20261029120000',
      Response: input.response ?? 'OK'
    };
    const body = new URLSearchParams({
      ...fields,
      AccountCode: this.options.secrets.accountCode,
      TpvID: this.options.secrets.terminal,
      AuthCode: input.authCode ?? stableCode('A', input.order),
      ...(input.card ? { IdUser: String(input.card.idUser), TokenUser: input.card.tokenUser, CardBrand: input.card.brand } : {}),
      NotificationHash: notificationHash(fields, this.options.secrets)
    });
    return { rawBody: body.toString(), contentType: 'application/x-www-form-urlencoded' };
  }

  private throwIfFailing(failure: MockFailure | undefined, order: string): void {
    const error = typeof failure === 'function' ? failure(order) : failure;
    if (error) throw error;
  }
}
