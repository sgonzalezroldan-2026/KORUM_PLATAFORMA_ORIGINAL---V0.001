import { z } from 'zod';
import { verifyPaycometNotification } from './paycomet-notification';
import {
  PaymentProviderError,
  type ChargeRequest,
  type ChargeResult,
  type ChargeMethod,
  type NotificationCheck,
  type PaymentProvider,
  type RefundRequest,
  type RefundResult,
  type SplitTransferRequest,
  type SplitTransferResult,
  type TokenizeRequest,
  type TokenizeResult
} from './payment-provider';

/**
 * Adaptador REST de Paycomet para `sandbox` y `live`, según su especificación oficial (rest.paycomet.com/swagger.yaml, consultada en
 * octubre de 2026). Aún no se ha ejecutado contra su sandbox: faltan las credenciales (tarea aplazada). Cualquier respuesta inesperada
 * falla de forma explícita, y un corte de conexión se marca como resultado desconocido para no mover dinero dos veces.
 */

const BASE_URL = 'https://rest.paycomet.com';
const REQUEST_TIMEOUT_MS = 20_000;
const CURRENCY = 'EUR';
const METHOD_ID: Record<ChargeMethod, number> = { CARD: 1, APPLE_PAY: 1, GOOGLE_PAY: 1, BIZUM: 11 };

export interface PaycometCredentials {
  apiKey: string;
  merchantCode: string;
  terminal: string;
  /** Contraseña del producto, con la que Paycomet firma sus notificaciones. */
  notificationPassword: string;
}

const SAFE_ORDER = /^[A-Za-z0-9_-]{1,70}$/;
const paymentResponse = z.object({ order: z.coerce.string().optional(), authCode: z.coerce.string().nullish(), challengeUrl: z.url({ protocol: /^https$/ }).nullish() });
const cardResponse = z.object({ idUser: z.coerce.number().int().positive(), tokenUser: z.string().min(1) });
const refundResponse = z.object({ authCode: z.coerce.string().nullish() });
const splitResponse = z.object({ submerchant: z.object({ splitAuthCode: z.coerce.string().min(1) }) });

export class PaycometAdapter implements PaymentProvider {
  readonly name = 'paycomet';

  constructor(
    readonly mode: 'sandbox' | 'live',
    private readonly credentials: PaycometCredentials,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private get terminal(): number {
    return Number(this.credentials.terminal);
  }

  private assertSafeOrder(order: string): void {
    if (!SAFE_ORDER.test(order)) throw new PaymentProviderError('El identificador del pedido no tiene un formato válido', 'INVALID_ORDER');
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.assertSafeOrder(request.order);
    if (request.method !== 'BIZUM' && !request.card) throw new PaymentProviderError('Un cobro con tarjeta necesita su token', 'CARD_TOKEN_REQUIRED');
    const body = await this.post('/v1/payments', {
      payment: {
        terminal: this.terminal,
        order: request.order,
        amount: String(request.amountCents),
        currency: CURRENCY,
        methodId: METHOD_ID[request.method],
        originalIp: request.originalIp,
        secure: 1,
        ...(request.card ? { idUser: request.card.idUser, tokenUser: request.card.tokenUser } : {}),
        ...(request.description ? { productDescription: request.description } : {})
      }
    });
    const parsed = this.parse(paymentResponse, body, 'cobro');
    return { order: request.order, authCode: parsed.authCode ?? null, challengeUrl: parsed.challengeUrl ?? null };
  }

  async tokenizeCard(request: TokenizeRequest): Promise<TokenizeResult> {
    return this.parse(cardResponse, await this.post('/v1/cards', { terminal: this.terminal, jetToken: request.jetToken }), 'tokenización');
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    this.assertSafeOrder(request.order);
    const body = await this.post(`/v1/payments/${encodeURIComponent(request.order)}/refund`, {
      payment: { terminal: this.terminal, amount: String(request.amountCents), currency: CURRENCY, authCode: request.authCode, originalIp: request.originalIp }
    });
    return { authCode: this.parse(refundResponse, body, 'reembolso').authCode ?? null };
  }

  async splitTransfer(request: SplitTransferRequest): Promise<SplitTransferResult> {
    this.assertSafeOrder(request.order);
    const body = await this.post('/v1/marketplace/split-transfer', {
      authCode: request.authCode,
      payment: { terminal: this.terminal, order: request.order, authCode: request.authCode },
      submerchant: { splitId: request.splitId, amount: request.amountCents, currency: CURRENCY }
    });
    return { splitAuthCode: this.parse(splitResponse, body, 'reparto').submerchant.splitAuthCode };
  }

  verifyNotification(rawBody: string, contentType: string | null): NotificationCheck {
    return verifyPaycometNotification(rawBody, contentType, {
      accountCode: this.credentials.merchantCode,
      terminal: this.credentials.terminal,
      password: this.credentials.notificationPassword
    });
  }

  private parse<T>(schema: z.ZodType<T>, body: unknown, operation: string): T {
    const parsed = schema.safeParse(body);
    // La operación ha ido bien pero no se entiende la respuesta: no se sabe qué ha pasado, así que no se reintenta.
    if (!parsed.success) throw new PaymentProviderError(`Respuesta inesperada de Paycomet en ${operation}`, 'UNEXPECTED_RESPONSE', true);
    return parsed.data;
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'PAYCOMET-API-TOKEN': this.credentials.apiKey },
        body: JSON.stringify(payload),
        // Una redirección llevaría la clave de la API a otro servidor.
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw new PaymentProviderError('No se pudo completar la llamada a Paycomet', 'NETWORK', true);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PaymentProviderError(`Paycomet respondió ${response.status} sin un cuerpo válido`, 'INVALID_BODY', response.ok || response.status >= 500);
    }
    const errorCode = (body as { errorCode?: unknown } | null)?.errorCode;
    if (!response.ok || (errorCode !== undefined && Number(errorCode) !== 0)) {
      throw new PaymentProviderError(`Paycomet rechazó la operación (HTTP ${response.status}, error ${String(errorCode ?? 'desconocido')})`, String(errorCode ?? response.status), response.status >= 500);
    }
    return body;
  }
}
