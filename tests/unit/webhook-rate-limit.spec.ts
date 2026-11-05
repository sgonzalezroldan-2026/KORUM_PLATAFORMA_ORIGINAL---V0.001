import { beforeEach, describe, expect, it, vi } from 'vitest';

const reserveAttempt = vi.fn<(db: unknown, key: string, rule: unknown) => Promise<boolean>>();
const releaseAttempt = vi.fn<(db: unknown, key: string) => Promise<void>>();
const getPaymentProvider = vi.fn(async () => ({ name: 'paycomet' }));
const handlePaymentWebhook = vi.fn<(...args: unknown[]) => Promise<{ status: number; outcome: string }>>();
const dispatchOutbox = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const reportError = vi.fn();
/** `after` real solo existe dentro de una petición de Next: aquí se ejecuta al momento para poder comprobar qué hace. */
const after = vi.fn((callback: () => Promise<void>) => callback());

vi.mock('@/config/env', () => ({ getEnv: () => ({ DATA_HMAC_SECRET: 'secreto-de-pruebas-del-limite-de-peticiones-0123456789', QR_HMAC_SECRET: 'otro-secreto-de-pruebas-0123456789-abcdefghi' }) }));
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({}) }));
vi.mock('@/lib/rate-limit', () => ({ reserveAttempt, releaseAttempt }));
vi.mock('next/server', () => ({ after }));
vi.mock('@/lib/error-reporting', () => ({ reportError }));
vi.mock('@/services/email/outbox-deps', () => ({ buildOutboxDeps: () => ({}) }));
vi.mock('@/services/email/outbox-processor', () => ({ dispatchOutbox }));
vi.mock('@/services/payments/provider-factory', () => ({ getPaymentProvider }));
vi.mock('@/services/payments/paycomet-webhook.service', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), handlePaymentWebhook }));

const { POST } = await import('@/app/api/webhooks/paycomet/route');

const request = (headers: Record<string, string> = {}) => new Request('https://korum.example/api/webhooks/paycomet', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: 'Order=1' });

describe('QA-OPS01 · límite de intentos del webhook de Paycomet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reserveAttempt.mockResolvedValue(true);
    releaseAttempt.mockResolvedValue(undefined);
    handlePaymentWebhook.mockResolvedValue({ status: 200, outcome: 'PROCESSED' });
    dispatchOutbox.mockResolvedValue({});
  });

  it('agotado el cupo de la red de origen, responde 429 sin descifrar credenciales ni procesar nada', async () => {
    reserveAttempt.mockResolvedValue(false);
    expect((await POST(request({ 'x-forwarded-for': '203.0.113.7' }))).status).toBe(429);
    expect(getPaymentProvider).not.toHaveBeenCalled();
    expect(handlePaymentWebhook).not.toHaveBeenCalled();
  });

  it('una notificación con firma válida devuelve el intento: Paycomet nunca gasta el cupo', async () => {
    expect((await POST(request({ 'x-forwarded-for': '203.0.113.7' }))).status).toBe(200);
    expect(releaseAttempt).toHaveBeenCalledTimes(1);
    expect(releaseAttempt.mock.calls[0]?.[1]).toBe(reserveAttempt.mock.calls[0]?.[1]);
  });

  it('tras un cobro procesado envía el recibo y las entradas en el propio flujo, sin retrasar la respuesta a Paycomet', async () => {
    expect((await POST(request({ 'x-forwarded-for': '203.0.113.7' }))).status).toBe(200);
    expect(after).toHaveBeenCalledTimes(1);
    expect(dispatchOutbox).toHaveBeenCalledTimes(1);
  });

  it('un duplicado o una notificación rechazada no disparan envíos', async () => {
    handlePaymentWebhook.mockResolvedValue({ status: 200, outcome: 'DUPLICATE' });
    await POST(request({ 'x-forwarded-for': '203.0.113.7' }));
    handlePaymentWebhook.mockResolvedValue({ status: 401, outcome: 'REJECTED' });
    await POST(request({ 'x-forwarded-for': '203.0.113.7' }));
    expect(dispatchOutbox).not.toHaveBeenCalled();
  });

  it('si el envío falla, el cobro sigue confirmado (200), el error se registra y los mensajes quedan para la tarea programada', async () => {
    dispatchOutbox.mockRejectedValue(new Error('proveedor caído'));
    expect((await POST(request({ 'x-forwarded-for': '203.0.113.7' }))).status).toBe(200);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('una firma inválida conserva el intento gastado', async () => {
    handlePaymentWebhook.mockResolvedValue({ status: 401, outcome: 'REJECTED' });
    expect((await POST(request({ 'x-forwarded-for': '203.0.113.7' }))).status).toBe(401);
    expect(releaseAttempt).not.toHaveBeenCalled();
  });

  it('la clave agrupa por subred y no lleva la IP en claro; sin IP válida va a un grupo común', async () => {
    await POST(request({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }));
    await POST(request({ 'x-forwarded-for': '203.0.113.200' }));
    await POST(request({ 'x-forwarded-for': 'no-es-una-ip' }));
    await POST(request());
    const keys = reserveAttempt.mock.calls.map((call) => call[1]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).toBe(keys[3]);
    expect(keys[0]).not.toBe(keys[2]);
    for (const key of keys) {
      expect(key).toMatch(/^webhook:paycomet:ip:[0-9a-f]{64}$/);
      expect(key).not.toContain('203.0.113');
    }
  });

  it('un cuerpo demasiado grande se rechaza antes de reservar nada', async () => {
    const huge = new Request('https://korum.example/api/webhooks/paycomet', { method: 'POST', headers: { 'content-length': '99999999' }, body: 'x' });
    expect((await POST(huge)).status).toBe(413);
    expect(reserveAttempt).not.toHaveBeenCalled();
  });
});
