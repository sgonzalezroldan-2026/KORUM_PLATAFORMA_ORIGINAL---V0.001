import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { assertCampaignDuration, CampaignDurationError, campaignDays, evaluateSplitWindow, planPayoutSplits, SplitWindowExpiredError } from '@/core/finance/campaign-window';
import { validateJournal } from '@/core/finance/ledger-validation';
import type { JournalLine } from '@/core/finance/ledger-accounts';
import { chargebackLines, donationOrTicketPayinLines, payoutApprovalLines, refundApprovalLines, refundExecutionLines, splitTransferLines } from '@/core/finance/payment-journals';
import { openField, sealField } from '@/lib/encryption';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { notificationHash, verifyPaycometNotification, type NotificationSecrets } from '@/services/payments/paycomet-notification';
import { PaycometAdapter } from '@/services/payments/paycomet.adapter';
import { PaymentProviderError, type PaymentProvider, type RefundRequest, type SplitTransferRequest } from '@/services/payments/payment-provider';
import { MAX_WEBHOOK_BODY_BYTES, readBodyWithLimit } from '@/services/payments/paycomet-webhook.service';
import { POST } from '@/app/api/webhooks/paycomet/route';
import { mockNotificationSecrets } from '@/services/payments/provider-factory';

const secrets: NotificationSecrets = { accountCode: 'ACC123', terminal: '4242', password: 'contraseña-de-pruebas' };
const FORM = 'application/x-www-form-urlencoded';
const fields = { TransactionType: '1', Order: 'ORD-1', Amount: '2680', Currency: 'EUR', BankDateTime: '20261029120000', Response: 'OK' };

function body(overrides: Record<string, string> = {}, hash?: string): string {
  const merged = { ...fields, AccountCode: secrets.accountCode, TpvID: secrets.terminal, AuthCode: 'AUTH1', ...overrides };
  return new URLSearchParams({ ...merged, NotificationHash: hash ?? notificationHash(merged, secrets) }).toString();
}

describe('firma de las notificaciones de Paycomet', () => {
  it('sigue la fórmula oficial: SHA-512 con el MD5 de la contraseña', () => {
    const md5 = createHash('md5').update(secrets.password).digest('hex');
    const expected = createHash('sha512').update(`ACC1234242${'1'}ORD-12680EUR${md5}20261029120000OK`).digest('hex');
    expect(notificationHash(fields, secrets)).toBe(expected);
  });

  it('acepta una notificación correcta, en formulario y en JSON', () => {
    const form = verifyPaycometNotification(body(), FORM, secrets);
    expect(form).toMatchObject({ valid: true, notification: { kind: 'PAYMENT_COMPLETED', order: 'ORD-1', amountCents: 2680, currency: 'EUR', authCode: 'AUTH1' } });
    const json = JSON.stringify(Object.fromEntries(new URLSearchParams(body())));
    expect(verifyPaycometNotification(json, 'application/json', secrets).valid).toBe(true);
  });

  it('rechaza cualquier campo firmado que se altere: importe, pedido, resultado o fecha', () => {
    const signed = notificationHash(fields, secrets);
    const changes: Array<Record<string, string>> = [{ Amount: '999999' }, { Order: 'ORD-2' }, { Response: 'KO' }, { BankDateTime: '20270101000000' }, { TransactionType: '2' }, { Currency: 'USD' }];
    for (const tampered of changes) {
      expect(verifyPaycometNotification(body(tampered, signed), FORM, secrets), JSON.stringify(tampered)).toEqual({ valid: false, reason: 'BAD_SIGNATURE' });
    }
  });

  it('rechaza una firma hecha con otra contraseña, sin firma o con un cuerpo que no se entiende', () => {
    const forged = notificationHash(fields, { ...secrets, password: 'otra' });
    expect(verifyPaycometNotification(body({}, forged), FORM, secrets)).toEqual({ valid: false, reason: 'BAD_SIGNATURE' });
    expect(verifyPaycometNotification('Order=ORD-1', FORM, secrets)).toEqual({ valid: false, reason: 'MALFORMED' });
    expect(verifyPaycometNotification('{no es json', 'application/json', secrets)).toEqual({ valid: false, reason: 'MALFORMED' });
    expect(verifyPaycometNotification(body({}, 'zz'.repeat(64)), FORM, secrets)).toEqual({ valid: false, reason: 'MALFORMED' });
  });

  it('rechaza una notificación firmada para otro terminal', () => {
    const other = { ...secrets, terminal: '9999' };
    const merged = { ...fields, AccountCode: secrets.accountCode, TpvID: '9999' };
    const raw = new URLSearchParams({ ...merged, NotificationHash: notificationHash(fields, other) }).toString();
    expect(verifyPaycometNotification(raw, FORM, secrets).valid).toBe(false);
  });

  it('traduce cada tipo de operación', () => {
    const kindOf = (TransactionType: string, Response = 'OK') => {
      const raw = body({ TransactionType, Response }, notificationHash({ ...fields, TransactionType, Response }, secrets));
      const check = verifyPaycometNotification(raw, FORM, secrets);
      return check.valid ? check.notification.kind : check.reason;
    };
    expect(kindOf('1')).toBe('PAYMENT_COMPLETED');
    expect(kindOf('1', 'KO')).toBe('PAYMENT_FAILED');
    expect(kindOf('2')).toBe('REFUND_COMPLETED');
    expect(kindOf('2', 'KO')).toBe('REFUND_FAILED');
    expect(kindOf('106')).toBe('CHARGEBACK');
    expect(kindOf('107')).toBe('IGNORED');
  });

  it('lo que se guarda no incluye el token de la tarjeta ni datos de quien paga', () => {
    const check = verifyPaycometNotification(body({ IdUser: '77', TokenUser: 'secreto', CardCountry: 'ES', Concept: 'nombre' }), FORM, secrets);
    expect(check.valid && Object.keys(check.notification.payload).sort()).toEqual(['Amount', 'AuthCode', 'BankDateTime', 'Currency', 'Order', 'Response', 'TransactionType']);
  });

  it('los campos sin firmar no sirven para fabricar identificadores ni entran con cualquier tipo', () => {
    const idOf = (raw: string, contentType = FORM) => {
      const check = verifyPaycometNotification(raw, contentType, secrets);
      return check.valid ? check.notification.externalEventId : check.reason;
    };
    expect(idOf(body({ paycometId: '1' }))).toBe(idOf(body({ paycometId: '2' })));
    expect(idOf(body({ AuthCode: 'OTRO' }))).toBe(idOf(body()));
    expect(idOf(body({ MethodId: '1' }))).toBe(idOf(body({ MethodId: '11' })));
    expect(idOf(body({ ErrorID: '0' }))).toBe(idOf(body({ ErrorID: '1001' })));
    const json = Object.fromEntries(new URLSearchParams(body()));
    expect(idOf(JSON.stringify({ ...json, TpvID: ['4242'] }), 'application/json')).toBe('MALFORMED');
    for (const bad of [{ AuthCode: ['1'] }, { AuthCode: { a: 1 } }, { AuthCode: 'con espacio' }, { paycometId: 'x'.repeat(30) }]) {
      const unusual = verifyPaycometNotification(JSON.stringify({ ...json, ...bad }), 'application/json', secrets);
      expect(unusual.valid, JSON.stringify(bad)).toBe(true);
      if ('AuthCode' in bad) expect(unusual.valid && unusual.notification.authCode, JSON.stringify(bad)).toBeNull();
      expect(unusual.valid && JSON.stringify(unusual.notification.payload), JSON.stringify(bad)).not.toContain('espacio');
    }
    const check = verifyPaycometNotification(JSON.stringify({ ...json, AuthCode: null, ErrorDescription: 'texto libre'.repeat(500) }), 'application/json', secrets);
    expect(check.valid && check.notification.authCode).toBeNull();
    expect(check.valid && JSON.stringify(check.notification.payload)).not.toContain('texto libre');
  });

  it('un contracargo sin confirmar no se aplica', () => {
    const fieldsKo = { ...fields, TransactionType: '106', Response: 'KO' };
    const check = verifyPaycometNotification(body(fieldsKo, notificationHash(fieldsKo, secrets)), FORM, secrets);
    expect(check.valid && check.notification.kind).toBe('IGNORED');
  });

  it('el identificador distingue operaciones y se repite al reenviar la misma', () => {
    const idOf = (raw: string) => {
      const check = verifyPaycometNotification(raw, FORM, secrets);
      return check.valid ? check.notification.externalEventId : '';
    };
    expect(idOf(body())).toBe(idOf(body()));
    const refund = { ...fields, TransactionType: '2' };
    expect(idOf(body({ TransactionType: '2' }, notificationHash(refund, secrets)))).not.toBe(idOf(body()));
  });
});

describe('simulador de Paycomet', () => {
  it('firma con la fórmula real: lo que él firma lo acepta el verificador real', () => {
    const mock = new MockPaycometProvider({ secrets });
    const { rawBody, contentType } = mock.buildNotification({ kind: 'PAYMENT', order: 'ORD-9', amountCents: 500 });
    expect(verifyPaycometNotification(rawBody, contentType, secrets)).toMatchObject({ valid: true, notification: { order: 'ORD-9', amountCents: 500 } });
    expect(verifyPaycometNotification(rawBody, contentType, { ...secrets, password: 'otra' }).valid).toBe(false);
  });

  it('es determinista', async () => {
    const charge = () => new MockPaycometProvider({ secrets }).charge({ order: 'O', amountCents: 100, method: 'BIZUM', originalIp: '10.0.0.1' });
    expect(await charge()).toEqual(await charge());
  });

  it('aplica las restricciones de Paycomet: no devuelve ni reparte más de lo cobrado', async () => {
    const mock = new MockPaycometProvider({ secrets });
    await mock.charge({ order: 'O', amountCents: 100, method: 'BIZUM', originalIp: '10.0.0.1' });
    await expect(mock.refund({ order: 'O', authCode: 'A', amountCents: 101, originalIp: '10.0.0.1' })).rejects.toMatchObject({ code: 'MOCK_REFUND_EXCEEDS_CHARGE' });
    await mock.refund({ order: 'O', authCode: 'A', amountCents: 100, originalIp: '10.0.0.1' });
    await expect(mock.refund({ order: 'O', authCode: 'A', amountCents: 1, originalIp: '10.0.0.1' })).rejects.toBeInstanceOf(PaymentProviderError);
    await expect(mock.splitTransfer({ order: 'O', authCode: 'A', splitId: 'S', amountCents: 101 })).rejects.toMatchObject({ code: 'MOCK_SPLIT_EXCEEDS_CHARGE' });
  });

  it('no reparte pasados 90 días desde el cobro', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const mock = new MockPaycometProvider({ secrets, now: () => now });
    await mock.charge({ order: 'O', amountCents: 100, method: 'BIZUM', originalIp: '10.0.0.1' });
    now = new Date('2026-04-01T00:00:00Z');
    await expect(mock.splitTransfer({ order: 'O', authCode: 'A', splitId: 'S', amountCents: 50 })).resolves.toBeDefined();
    now = new Date('2026-04-02T00:00:01Z');
    await expect(mock.splitTransfer({ order: 'O', authCode: 'A', splitId: 'S', amountCents: 50 })).rejects.toMatchObject({ code: 'MOCK_SPLIT_WINDOW' });
  });

  it('un cobro con tarjeta exige token', async () => {
    await expect(new MockPaycometProvider({ secrets }).charge({ order: 'O', amountCents: 100, method: 'CARD', originalIp: '10.0.0.1' })).rejects.toMatchObject({ code: 'MOCK_NO_CARD' });
  });

  it('la contraseña del simulador sale de un secreto del entorno, no del código', () => {
    expect(mockNotificationSecrets('a'.repeat(32)).password).not.toBe(mockNotificationSecrets('b'.repeat(32)).password);
  });
});

describe('adaptador REST de Paycomet', () => {
  const credentials = { apiKey: 'API-KEY', merchantCode: 'ACC123', terminal: '4242', notificationPassword: 'pw' };
  const respond = (json: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(json), { status }));
  const sent = (fetchMock: ReturnType<typeof respond>) => {
    const [url, init] = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
    return { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) as Record<string, Record<string, unknown>> };
  };

  it('cobra con Bizum en céntimos y sin datos de tarjeta', async () => {
    const fetchMock = respond({ errorCode: 0, order: 'O', authCode: 'A1', challengeUrl: 'https://pay.example/x' });
    const adapter = new PaycometAdapter('sandbox', credentials, fetchMock as unknown as typeof fetch);
    expect(await adapter.charge({ order: 'O', amountCents: 2680, method: 'BIZUM', originalIp: '10.0.0.1' })).toEqual({ order: 'O', authCode: 'A1', challengeUrl: 'https://pay.example/x' });
    const request = sent(fetchMock);
    expect(request.url).toBe('https://rest.paycomet.com/v1/payments');
    expect(request.headers['PAYCOMET-API-TOKEN']).toBe('API-KEY');
    expect(request.body.payment).toEqual({ terminal: 4242, order: 'O', amount: '2680', currency: 'EUR', methodId: 11, originalIp: '10.0.0.1', secure: 1 });
  });

  it('el reembolso va al pedido original', async () => {
    const fetchMock = respond({ errorCode: 0, authCode: 'R1' });
    const adapter = new PaycometAdapter('sandbox', credentials, fetchMock as unknown as typeof fetch);
    expect(await adapter.refund({ order: 'ORD-1', authCode: 'A1', amountCents: 2680, originalIp: '10.0.0.1' })).toEqual({ authCode: 'R1' });
    const request = sent(fetchMock);
    expect(request.url).toBe('https://rest.paycomet.com/v1/payments/ORD-1/refund');
    expect(request.body.payment).toEqual({ terminal: 4242, amount: '2680', currency: 'EUR', authCode: 'A1', originalIp: '10.0.0.1' });
  });

  it('no acepta pedidos que alteren la ruta, no sigue redirecciones y solo admite enlaces https', async () => {
    const fetchMock = respond({ errorCode: 0, authCode: 'R1' });
    const adapter = new PaycometAdapter('sandbox', credentials, fetchMock as unknown as typeof fetch);
    for (const order of ['..', 'ORD/1', '.', 'a b']) {
      await expect(adapter.refund({ order, authCode: 'A', amountCents: 1, originalIp: '10.0.0.1' }), order).rejects.toMatchObject({ code: 'INVALID_ORDER', outcomeUnknown: false });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await adapter.refund({ order: 'ORD-1', authCode: 'A', amountCents: 1, originalIp: '10.0.0.1' });
    expect(((fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0]![1]).redirect).toBe('error');
    const insecure = new PaycometAdapter('sandbox', credentials, respond({ errorCode: 0, challengeUrl: 'http://malo.example/x' }) as unknown as typeof fetch);
    await expect(insecure.charge({ order: 'O', amountCents: 1, method: 'BIZUM', originalIp: '10.0.0.1' })).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('el reparto cita el cobro original y la cuenta destino', async () => {
    const fetchMock = respond({ errorCode: 0, order: 'O', submerchant: { amount: 500, currency: 'EUR', splitAuthCode: 'S1' } });
    const adapter = new PaycometAdapter('live', credentials, fetchMock as unknown as typeof fetch);
    expect(await adapter.splitTransfer({ order: 'O', authCode: 'A1', splitId: 'SPLIT', amountCents: 500 })).toEqual({ splitAuthCode: 'S1' });
    const request = sent(fetchMock);
    expect(request.url).toBe('https://rest.paycomet.com/v1/marketplace/split-transfer');
    expect(request.body.submerchant).toEqual({ splitId: 'SPLIT', amount: 500, currency: 'EUR' });
    expect(request.body.payment).toEqual({ terminal: 4242, order: 'O', authCode: 'A1' });
  });

  it('un rechazo es un error definitivo; se puede corregir y reintentar', async () => {
    const adapter = new PaycometAdapter('sandbox', credentials, respond({ errorCode: 130, error: { message: 'x' } }, 422) as unknown as typeof fetch);
    await expect(adapter.refund({ order: 'O', authCode: 'A', amountCents: 1, originalIp: '10.0.0.1' })).rejects.toMatchObject({ code: '130', outcomeUnknown: false });
  });

  it('un errorCode en una respuesta 200 también es un rechazo', async () => {
    const adapter = new PaycometAdapter('sandbox', credentials, respond({ errorCode: 1001 }) as unknown as typeof fetch);
    await expect(adapter.refund({ order: 'O', authCode: 'A', amountCents: 1, originalIp: '10.0.0.1' })).rejects.toMatchObject({ code: '1001', outcomeUnknown: false });
  });

  it('un corte de conexión o una respuesta incomprensible dejan el resultado como desconocido: no se reintenta a ciegas', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const network = new PaycometAdapter('sandbox', credentials, down as unknown as typeof fetch);
    await expect(network.splitTransfer({ order: 'O', authCode: 'A', splitId: 'S', amountCents: 1 })).rejects.toMatchObject({ outcomeUnknown: true });
    const garbled = new PaycometAdapter('sandbox', credentials, respond({ errorCode: 0 }) as unknown as typeof fetch);
    await expect(garbled.splitTransfer({ order: 'O', authCode: 'A', splitId: 'S', amountCents: 1 })).rejects.toMatchObject({ outcomeUnknown: true, code: 'UNEXPECTED_RESPONSE' });
    const server = new PaycometAdapter('sandbox', credentials, respond({}, 503) as unknown as typeof fetch);
    await expect(server.splitTransfer({ order: 'O', authCode: 'A', splitId: 'S', amountCents: 1 })).rejects.toMatchObject({ outcomeUnknown: true });
  });

  it('verifica las notificaciones con sus credenciales', () => {
    const adapter = new PaycometAdapter('sandbox', credentials, respond({}) as unknown as typeof fetch);
    const own = { accountCode: 'ACC123', terminal: '4242', password: 'pw' };
    const raw = new MockPaycometProvider({ secrets: own }).buildNotification({ kind: 'PAYMENT', order: 'O', amountCents: 1 });
    expect(adapter.verifyNotification(raw.rawBody, raw.contentType).valid).toBe(true);
  });
});

describe('QA-P02 · el dinero solo vuelve al cobro original', () => {
  it('el contrato no admite ningún destino libre: añadir un campo o un método rompe esta prueba', () => {
    expectTypeOf<keyof RefundRequest>().toEqualTypeOf<'order' | 'authCode' | 'amountCents' | 'originalIp'>();
    expectTypeOf<keyof SplitTransferRequest>().toEqualTypeOf<'order' | 'authCode' | 'splitId' | 'amountCents'>();
    // `listCharges` (Sprint 2.4) solo lee y `deleteCard` (Sprint 2.5) solo borra una tarjeta: ninguno mueve dinero ni admite destino.
    expectTypeOf<keyof PaymentProvider>().toEqualTypeOf<'mode' | 'name' | 'charge' | 'tokenizeCard' | 'deleteCard' | 'refund' | 'splitTransfer' | 'listCharges' | 'verifyNotification'>();
  });

  it('ningún archivo de pagos ni el webhook aceptan un IBAN', () => {
    const directory = join(process.cwd(), 'src', 'services', 'payments');
    const files = [...readdirSync(directory).map((file) => join(directory, file)), join(process.cwd(), 'src', 'app', 'api', 'webhooks', 'paycomet', 'route.ts')];
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(/iban/i.test(code), file).toBe(false);
    }
  });
});

describe('QA-P04 · duración de la campaña y ventana de 90 días', () => {
  const publishedAt = new Date('2026-01-01T00:00:00Z');
  const after = (days: number) => new Date(publishedAt.getTime() + days * 86_400_000);

  it('rechaza una campaña más larga que maxCampaignDays con un mensaje claro', () => {
    expect(() => assertCampaignDuration(publishedAt, after(60), 60)).not.toThrow();
    expect(() => assertCampaignDuration(publishedAt, after(61), 60)).toThrow(CampaignDurationError);
    expect(() => assertCampaignDuration(publishedAt, after(61), 60)).toThrow(/61 días y el máximo son 60/);
  });

  it('un día empezado cuenta entero', () => {
    expect(campaignDays(publishedAt, new Date(after(60).getTime() + 1))).toBe(61);
  });

  it('el límite de 75 días no se puede superar ni subiendo el ajuste', () => {
    expect(() => assertCampaignDuration(publishedAt, after(75), 200)).not.toThrow();
    expect(() => assertCampaignDuration(publishedAt, after(76), 200)).toThrow(/máximo son 75/);
  });

  it('avisa cuando quedan 15 días de ventana: a los 75 días del primer cobro', () => {
    expect(evaluateSplitWindow(publishedAt, after(74))).toEqual({ daysElapsed: 74, daysLeft: 16, shouldWarn: false, expired: false });
    expect(evaluateSplitWindow(publishedAt, after(75))).toEqual({ daysElapsed: 75, daysLeft: 15, shouldWarn: true, expired: false });
    expect(evaluateSplitWindow(publishedAt, after(90))).toMatchObject({ daysLeft: 0, expired: false });
    // Mismo corte que planPayoutSplits: pasados 90 días exactos, ya está fuera.
    expect(evaluateSplitWindow(publishedAt, new Date(after(90).getTime() + 1))).toMatchObject({ daysLeft: 0, expired: true });
    expect(evaluateSplitWindow(publishedAt, after(91))).toMatchObject({ daysLeft: -1, expired: true });
  });
});

describe('planPayoutSplits · reparto cobro a cobro', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

  it('cubre el neto exacto empezando por los cobros que antes caducan', () => {
    const plan = planPayoutSplits(
      [
        { contributionId: 2, totalChargedCents: 1_000, chargedAt: daysAgo(10) },
        { contributionId: 1, totalChargedCents: 1_000, chargedAt: daysAgo(80) },
        { contributionId: 3, totalChargedCents: 1_000, chargedAt: daysAgo(5) }
      ],
      1_500,
      now
    );
    expect(plan).toEqual([
      { contributionId: 1, amountCents: 1_000 },
      { contributionId: 2, amountCents: 500 }
    ]);
  });

  it('no usa cobros fuera de la ventana y falla si lo demás no alcanza', () => {
    const charges = [
      { contributionId: 1, totalChargedCents: 1_000, chargedAt: daysAgo(91) },
      { contributionId: 2, totalChargedCents: 400, chargedAt: daysAgo(10) }
    ];
    expect(planPayoutSplits(charges, 400, now)).toEqual([{ contributionId: 2, amountCents: 400 }]);
    expect(() => planPayoutSplits(charges, 500, now)).toThrow(SplitWindowExpiredError);
  });

  it('ignora cobros sin importe y no genera repartos si no hay nada que pagar', () => {
    expect(planPayoutSplits([{ contributionId: 1, totalChargedCents: 0, chargedAt: daysAgo(1) }], 0, now)).toEqual([]);
  });
});

describe('asientos de cada operación: siempre cuadran y refunden lo cobrado', () => {
  const scope = { organizationId: 'ORG', initiativeId: 7 };
  const assertPostable = (lines: JournalLine[]) => validateJournal({ idempotencyKey: 'k', kind: 'PAYIN_DONATION', description: 'd', organizationId: 'ORG', lines });
  const donation = donationOrTicketPayinLines(scope, { type: 'DONATION', amountCents: 2_500, guaranteeCents: 180, serviceFeeCents: 0, totalChargedCents: 2_680 });
  const ticket = donationOrTicketPayinLines(scope, { type: 'TICKET', amountCents: 500, guaranteeCents: 0, serviceFeeCents: 55, totalChargedCents: 555 });

  it('los cobros siguen los asientos tipo de la skill', () => {
    expect(donation.map((line) => [line.account, line.direction, line.amountCents])).toEqual([
      ['PSP_CLEARING', 'DEBIT', 2_680],
      ['INITIATIVE_ESCROW', 'CREDIT', 2_500],
      ['KORUM_REVENUE_GUARANTEE', 'CREDIT', 180]
    ]);
    expect(ticket.map((line) => [line.account, line.amountCents])).toEqual([
      ['PSP_CLEARING', 555],
      ['INITIATIVE_ESCROW', 500],
      ['KORUM_REVENUE_TICKET_FEE', 55]
    ]);
  });

  it('el reembolso devuelve el 100 % de lo cobrado, aportación voluntaria incluida', () => {
    const approval = refundApprovalLines(donation, 'ORG', 2_680);
    expect(approval.map((line) => [line.account, line.direction, line.amountCents])).toEqual([
      ['INITIATIVE_ESCROW', 'DEBIT', 2_500],
      ['KORUM_REVENUE_GUARANTEE', 'DEBIT', 180],
      ['REFUNDS_PAYABLE', 'CREDIT', 2_680]
    ]);
    assertPostable(approval);
    assertPostable(refundExecutionLines('ORG', 2_680));
    assertPostable(refundApprovalLines(ticket, 'ORG', 555));
  });

  it('el contracargo cuadra en los tres casos', () => {
    const inEscrow = chargebackLines('IN_ESCROW', donation, 'ORG', 2_680);
    expect(inEscrow.map((line) => line.account)).toEqual(['INITIATIVE_ESCROW', 'KORUM_REVENUE_GUARANTEE', 'PSP_CLEARING']);
    expect(chargebackLines('KORUM_LOSS', donation, 'ORG', 2_680).map((line) => line.account)).toEqual(['CHARGEBACK_LOSSES', 'PSP_CLEARING']);
    expect(chargebackLines('REFUND_PENDING', donation, 'ORG', 2_680).map((line) => line.account)).toEqual(['REFUNDS_PAYABLE', 'PSP_CLEARING']);
    for (const mode of ['IN_ESCROW', 'KORUM_LOSS', 'REFUND_PENDING'] as const) assertPostable(chargebackLines(mode, donation, 'ORG', 2_680));
  });

  it('la liquidación reparte lo recaudado entre entidad, comisión y pasarela', () => {
    const lines = payoutApprovalLines(scope, { raisedCents: 583_300, netPaidCents: 561_000, bracketFeeCents: 14_440, maintFeeCents: 0, gatewayInGoalCents: 7_860 });
    assertPostable(lines);
    expect(lines.map((line) => line.account)).toEqual(['INITIATIVE_ESCROW', 'ORG_PAYABLE', 'KORUM_REVENUE_BRACKET', 'GATEWAY_FEES_RECOVERED']);
    assertPostable(splitTransferLines('ORG', 561_000));
  });
});

describe('límite del cuerpo del webhook', () => {
  const chunked = (chunks: number, size: number) =>
    new Request('https://korum.example/api/webhooks/paycomet', {
      method: 'POST',
      duplex: 'half',
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < chunks; i += 1) controller.enqueue(new Uint8Array(size).fill(97));
          controller.close();
        }
      })
    } as RequestInit);

  it('un cuerpo sin tamaño declarado se corta al superar el límite, sin leerlo entero', async () => {
    const request = chunked(100, 32 * 1024);
    expect(request.headers.get('content-length')).toBeNull();
    expect(await readBodyWithLimit(request)).toBeNull();
  });

  it('la ruta responde 413 antes de tocar la base de datos o las credenciales', async () => {
    expect((await POST(chunked(3, MAX_WEBHOOK_BODY_BYTES))).status).toBe(413);
    const declared = new Request('https://korum.example/api/webhooks/paycomet', { method: 'POST', headers: { 'content-length': String(MAX_WEBHOOK_BODY_BYTES + 1) }, body: 'x' });
    expect((await POST(declared)).status).toBe(413);
  });

  it('un cuerpo normal se lee entero y sin alterar, también con caracteres partidos entre trozos', async () => {
    const bytes = new TextEncoder().encode('Order=ñandú&Amount=1');
    const split = new Request('https://korum.example/x', {
      method: 'POST',
      duplex: 'half',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 7));
          controller.enqueue(bytes.slice(7));
          controller.close();
        }
      })
    } as RequestInit);
    expect(await readBodyWithLimit(split)).toBe('Order=ñandú&Amount=1');
  });
});

describe('cifrado de los tokens de tarjeta', () => {
  const key = Buffer.alloc(32, 7).toString('base64');

  it('ida y vuelta, sin dejar el valor en claro', () => {
    const sealed = sealField('token-secreto', key, 'paycomet:tokenUser');
    expect(sealed).not.toContain('token-secreto');
    expect(openField(sealed, key, 'paycomet:tokenUser')).toBe('token-secreto');
    expect(sealField('x', key, 'c')).not.toBe(sealField('x', key, 'c'));
  });

  it('no se descifra con otra clave, en otro campo ni si se altera', () => {
    const sealed = sealField('token-secreto', key, 'paycomet:tokenUser');
    expect(() => openField(sealed, Buffer.alloc(32, 8).toString('base64'), 'paycomet:tokenUser')).toThrow();
    expect(() => openField(sealed, key, 'paycomet:idUser')).toThrow();
    const [iv, tag] = sealed.split('.');
    expect(() => openField(`${iv}.${tag}.${Buffer.from('otro').toString('base64')}`, key, 'paycomet:tokenUser')).toThrow();
  });
});
