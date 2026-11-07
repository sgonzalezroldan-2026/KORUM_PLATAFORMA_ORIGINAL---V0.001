import { z } from 'zod';
import { verifyPaycometNotification } from './paycomet-notification';
import {
  PaymentProviderError,
  type ChargeRequest,
  type ChargeResult,
  type ChargeMethod,
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

/** Tope de resultados por consulta de operaciones (valor por defecto de Paycomet). Si se alcanza, la lista podría estar recortada. */
const SEARCH_LIMIT = 10_000;
const MAX_SEARCH_AMOUNT_CENTS = 100_000_000;
const OPERATION_AUTHORIZATION = 1;
const STATE_CORRECT = 1;
const SAFE_ORDER = /^[A-Za-z0-9_-]{1,70}$/;
const paymentResponse = z.object({ order: z.coerce.string().optional(), authCode: z.coerce.string().nullish(), challengeUrl: z.url({ protocol: /^https$/ }).nullish() });
const formResponse = z.object({ challengeUrl: z.url({ protocol: /^https$/ }) });
const cardResponse = z.object({ idUser: z.coerce.number().int().positive(), tokenUser: z.string().min(1) });
const refundResponse = z.object({ authCode: z.coerce.string().nullish() });
const searchResponse = z.object({
  operations: z
    .array(z.object({ order: z.coerce.string().min(1), amount: z.coerce.number().int().nonnegative(), authCode: z.coerce.string().nullish(), timestamp: z.string().regex(/^\d{14}$/), state: z.coerce.number().int(), operationType: z.coerce.number().int() }))
    .default([])
});
const splitResponse = z.object({ submerchant: z.object({ splitAuthCode: z.coerce.string().min(1) }) });

const pad = (value: number) => String(value).padStart(2, '0');

function formatPaycometDate(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function parsePaycometDate(value: string): Date {
  return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`);
}

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
        // Sin la persona delante (Mi Hucha) no hay autenticación reforzada: operación recurrente con la excepción MIT. **A confirmar con Paycomet**
        // (CUMPLIMIENTO §9, Sprint 3.8 b): nombres y valores de `secure`, `trxType` y `scaException`, y la IP que se envía (la del servidor).
        secure: request.merchantInitiated ? 0 : 1,
        ...(request.card ? { idUser: request.card.idUser, tokenUser: request.card.tokenUser } : {}),
        ...(request.merchantInitiated ? { trxType: 'R', scaException: 'MIT' } : {}),
        ...(request.description ? { productDescription: request.description } : {})
      }
    });
    const parsed = this.parse(paymentResponse, body, 'cobro');
    return { order: request.order, authCode: parsed.authCode ?? null, challengeUrl: parsed.challengeUrl ?? null };
  }

  /**
   * `POST /v1/form` con `operationType 1` (autorización): Paycomet devuelve la URL de su página de pago, donde la persona paga con tarjeta,
   * Apple Pay, Google Pay o Bizum y vuelve a `urlOk`/`urlKo`. Suposición contra la especificación, sin probar en el sandbox: confirmar los
   * nombres de los campos, el código de idioma y que el resultado llega por la notificación habitual (tareas aplazadas, ficha 6.1).
   * Con `saveCard` (primer pago de Mi Hucha) se marca como primer cobro de una serie recurrente (`trxType: 'R'`) para que Paycomet guarde la
   * tarjeta y la notificación traiga `IdUser` y `TokenUser`: también a confirmar en el sandbox.
   */
  async startHostedPayment(request: HostedPaymentRequest): Promise<HostedPaymentResult> {
    this.assertSafeOrder(request.order);
    const body = await this.post('/v1/form', {
      operationType: OPERATION_AUTHORIZATION,
      language: request.locale,
      terminal: this.terminal,
      payment: {
        terminal: this.terminal,
        order: request.order,
        amount: String(request.amountCents),
        currency: CURRENCY,
        methods: [METHOD_ID[request.method]],
        originalIp: request.originalIp,
        secure: 1,
        urlOk: request.urlOk,
        urlKo: request.urlKo,
        ...(request.saveCard ? { trxType: 'R' } : {}),
        ...(request.description ? { productDescription: request.description } : {})
      }
    });
    const parsed = this.parse(formResponse, body, 'página de pago');
    return { order: request.order, challengeUrl: parsed.challengeUrl };
  }

  async tokenizeCard(request: TokenizeRequest): Promise<TokenizeResult> {
    return this.parse(cardResponse, await this.post('/v1/cards', { terminal: this.terminal, jetToken: request.jetToken }), 'tokenización');
  }

  /**
   * `POST /v1/cards/delete` (borrado de usuario de la especificación REST). Suposición contra la documentación, sin probar en el sandbox:
   * confirmar el nombre de la operación y qué responde si la tarjeta ya no existe (tareas aplazadas, ficha 6.1).
   */
  async deleteCard(card: TokenizeResult): Promise<void> {
    await this.post('/v1/cards/delete', { terminal: this.terminal, idUser: card.idUser, tokenUser: card.tokenUser });
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

  /**
   * Cobros confirmados (`POST /v1/payments/search`, operación 1 «Autorización» con resultado correcto). Paycomet fecha en formato
   * `YmdHis`; se asume UTC, igual que `BankDateTime` de las notificaciones (suposición contra la documentación: confirmar en el sandbox).
   */
  async listCharges(range: { from: Date; to: Date }): Promise<PspCharge[]> {
    const body = await this.post('/v1/payments/search', {
      terminal: this.terminal,
      sortType: 1,
      sortOrder: 'ASC',
      operations: [OPERATION_AUTHORIZATION],
      minAmount: 0,
      maxAmount: MAX_SEARCH_AMOUNT_CENTS,
      state: STATE_CORRECT,
      fromDate: formatPaycometDate(range.from),
      toDate: formatPaycometDate(range.to),
      currency: CURRENCY,
      limit: SEARCH_LIMIT
    });
    const { operations } = this.parse(searchResponse, body, 'consulta de operaciones');
    if (operations.length >= SEARCH_LIMIT) throw new PaymentProviderError('La consulta de Paycomet alcanzó su límite de resultados: la lista puede estar incompleta', 'SEARCH_TRUNCATED');
    return operations
      .filter((operation) => operation.operationType === OPERATION_AUTHORIZATION && operation.state === STATE_CORRECT)
      .map((operation) => ({ order: operation.order, amountCents: operation.amount, authCode: operation.authCode ?? null, occurredAt: parsePaycometDate(operation.timestamp) }));
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
