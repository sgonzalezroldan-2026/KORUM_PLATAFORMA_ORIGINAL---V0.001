import { z } from 'zod';
import { assertVerifiedSuperadmin, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import type { Db } from '@/lib/db';
import { reportError } from '@/lib/error-reporting';
import { reserveAttempt } from '@/lib/rate-limit';
import { CONNECTION_TEST_RULE } from '@/lib/rate-limit-rules';
import type { RequestMeta } from '@/repositories/tenant-guard';
import { BrevoEmailProvider } from '@/services/email/brevo-email-provider';
import { EmailConfigurationError, EmailSendError } from '@/services/email/email-provider';
import { resolveEmailSender } from '@/services/email/provider-factory';
import { PaycometAdapter } from '@/services/payments/paycomet.adapter';
import { PaymentProviderError } from '@/services/payments/payment-provider';
import { PaymentConfigurationError, resolvePaycometCredentials } from '@/services/payments/provider-factory';
import { getSecret, getSetting, InvalidSettingError } from '@/services/settings/settings.service';
import { DecryptionError } from '@/core/security/crypto';
import { auditConnectionTest, SettingsRejectedError } from './platform-settings.service';
import type { SettingsRuntime } from './settings-runtime';

/**
 * «Probar conexión» de `/admin/ajustes` (Sprint 5.4). Solo comprueba lo que ya está **guardado** (no lo que se está escribiendo): así la prueba y el servicio real usan las mismas credenciales.
 *
 * - Los destinos son fijos (Paycomet y Brevo): ninguna dirección sale del navegador, así que la prueba no se puede usar para que el servidor llame a otro sitio.
 * - Con cobros simulados (`PAYCOMET_MODE=mock`) no se llama a nadie: el simulador no tiene credenciales que comprobar (`SIMULATED`).
 * - Hay un tope de 10 pruebas cada 10 minutos por persona: cada una gasta una llamada con las credenciales de la plataforma.
 * - El resultado solo dice **qué falta** o **el código** que devolvió el proveedor, nunca su respuesta, y queda en la auditoría sin credenciales.
 * - Veri*factu aún no tiene proveedor real (Sprint 4.2b): solo se comprueba que los datos del emisor están completos.
 */

export const CONNECTION_TARGETS = ['paycomet', 'email', 'invoicing'] as const;
export type ConnectionTarget = (typeof CONNECTION_TARGETS)[number];

export type ConnectionResult =
  | { status: 'OK' }
  | { status: 'SIMULATED' }
  | { status: 'NOT_CONFIGURED'; missing: string[] }
  | { status: 'FAILED'; code: string }
  | { status: 'RATE_LIMITED' };

/** El código que se enseña viene del proveedor: solo se admite uno corto y con forma de código (nunca texto libre de su respuesta). */
const safeCode = (code: string): string => (/^[A-Za-z0-9_]{1,24}$/.test(code) ? code : 'UNKNOWN');

async function testPaycomet(db: Db, runtime: SettingsRuntime): Promise<ConnectionResult> {
  const mode = runtime.paycometMode;
  if (mode === 'mock') return { status: 'SIMULATED' };
  const missing: string[] = [];
  try {
    if (!(await getSetting(db, 'paycomet.serverIp', runtime.fallbacks))) missing.push('paycomet.serverIp');
    const credentials = await resolvePaycometCredentials(db, runtime.keyring, runtime.fallbacks);
    if (missing.length > 0) return { status: 'NOT_CONFIGURED', missing };
    await new PaycometAdapter(mode, credentials, runtime.fetchImpl).verifyCredentials();
    return { status: 'OK' };
  } catch (error) {
    if (error instanceof PaymentConfigurationError) return { status: 'NOT_CONFIGURED', missing: [...error.missing.map((name) => PAYCOMET_FIELD[name] ?? name), ...missing] };
    // Demasiados resultados en la consulta de prueba: el proveedor aceptó las credenciales, solo que la lista de los últimos minutos no cabe.
    if (error instanceof PaymentProviderError && error.code === 'SEARCH_TRUNCATED') return { status: 'OK' };
    if (error instanceof PaymentProviderError) return { status: 'FAILED', code: safeCode(error.code) };
    // Un ajuste guardado que no es válido o una clave que no se descifra: se dice en lenguaje llano en lugar de un error genérico.
    if (error instanceof InvalidSettingError || error instanceof DecryptionError) return { status: 'FAILED', code: 'CONFIG' };
    reportError(error, { area: 'connection-test', target: 'paycomet' });
    return { status: 'FAILED', code: 'UNKNOWN' };
  }
}

/** Nombre de cada campo en la consola, para decir qué falta (el servicio de pagos los llama por su nombre interno). */
const PAYCOMET_FIELD: Record<string, string> = { apiKey: 'paycomet.apiKey', notificationPassword: 'paycomet.webhookSecret', merchantCode: 'paycomet.merchantCode', terminal: 'paycomet.terminalId' };

async function testEmail(db: Db, runtime: SettingsRuntime): Promise<ConnectionResult> {
  if (runtime.paycometMode === 'mock') return { status: 'SIMULATED' };
  const missing: string[] = [];
  let apiKey: string | undefined;
  try {
    apiKey = await getSecret(db, runtime.keyring, 'email.apiKey', runtime.fallbacks);
    if (!apiKey) missing.push('email.apiKey');
    if (!(await resolveEmailSender(db, runtime.paycometMode))) missing.push('email.fromAddress');
    if ((await getSetting(db, 'email.provider', runtime.fallbacks)) !== 'brevo') missing.push('email.provider');
  } catch (error) {
    if (error instanceof InvalidSettingError || error instanceof DecryptionError) return { status: 'FAILED', code: 'CONFIG' };
    throw error;
  }
  if (missing.length > 0 || !apiKey) return { status: 'NOT_CONFIGURED', missing };
  try {
    await new BrevoEmailProvider(apiKey, runtime.fetchImpl).checkCredentials();
    return { status: 'OK' };
  } catch (error) {
    if (error instanceof EmailConfigurationError) return { status: 'FAILED', code: 'REJECTED' };
    if (error instanceof EmailSendError) return { status: 'FAILED', code: 'NETWORK' };
    reportError(error, { area: 'connection-test', target: 'email' });
    return { status: 'FAILED', code: 'UNKNOWN' };
  }
}

async function testInvoicing(db: Db, runtime: SettingsRuntime): Promise<ConnectionResult> {
  const missing: string[] = [];
  try {
    if (!(await getSetting(db, 'invoicing.issuerNif', runtime.fallbacks))) missing.push('invoicing.issuerNif');
    if (!(await getSetting(db, 'invoicing.issuerName', runtime.fallbacks))) missing.push('invoicing.issuerName');
  } catch (error) {
    if (error instanceof InvalidSettingError) return { status: 'FAILED', code: 'CONFIG' };
    throw error;
  }
  return missing.length > 0 ? { status: 'NOT_CONFIGURED', missing } : { status: 'SIMULATED' };
}

export async function testConnection(db: Db, actor: VerifiedSuperadminActor, rawTarget: unknown, runtime: SettingsRuntime, meta?: RequestMeta, now: Date = new Date()): Promise<ConnectionResult> {
  assertVerifiedSuperadmin(actor, 'settings.connection_test', now);
  const parsed = z.enum(CONNECTION_TARGETS).safeParse(rawTarget);
  if (!parsed.success) throw new SettingsRejectedError('INVALID');
  if (!(await reserveAttempt(db, `${CONNECTION_TEST_RULE.prefix}${actor.userId}`, CONNECTION_TEST_RULE, now))) return { status: 'RATE_LIMITED' };
  const target = parsed.data;
  const result = target === 'paycomet' ? await testPaycomet(db, runtime) : target === 'email' ? await testEmail(db, runtime) : await testInvoicing(db, runtime);
  await auditConnectionTest(db, actor, target, result.status, result.status === 'FAILED' ? result.code : null, meta);
  return result;
}
