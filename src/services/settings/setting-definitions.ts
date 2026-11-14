import { isIP } from 'node:net';
import { z } from 'zod';
import { CRAWLER_USER_AGENT, LEGAL_DOCUMENTS, LEGAL_LOCALES, LEGAL_VERSION_PATTERN, SEARCH_VERIFICATION_TOKEN, type LegalDocument, type LegalLocale } from '@/core/admin/settings-model';
import { validateTaxId } from '@/core/tax/tax-id';

/**
 * Catálogo de ajustes de `/admin/ajustes` (DECISIONES_TECNICAS §6). Cada clave tiene su validación Zod y, si la tiene, la variable de
 * respaldo que se usa mientras la consola no tenga valor. Una clave que no esté aquí no se puede leer ni guardar: así un error de
 * tecleo en la consola no crea ajustes fantasma. Los secretos van aparte (`SECRET_DEFINITIONS`) porque se guardan cifrados.
 */

const text = (max = 200) => z.string().trim().min(1).max(max);
const ipAddress = z.string().trim().refine((value) => isIP(value) !== 0, 'Debe ser una dirección IPv4 o IPv6');
const taxId = z.string().trim().refine((value) => validateTaxId(value).valid, 'NIF o CIF no válido');

const legalText = z.object({
  version: z.string().regex(LEGAL_VERSION_PATTERN, 'La versión es la fecha de publicación (AAAA-MM-DD, con «.1», «.2»… si hay varias el mismo día)'),
  status: z.enum(['BORRADOR', 'PUBLICADO']),
  markdown: z.string().min(1).max(200_000)
});

const company = z.object({
  legalName: text(),
  taxId,
  address: text(300),
  supportEmail: z.email(),
  privacyEmail: z.email()
});

const acknowledgement = z.object({ code: text(80), fingerprint: text(200), acknowledgedById: text(80), acknowledgedAt: z.iso.datetime(), note: z.string().max(1000) });

/** Un rastreador de `seo.aiCrawlers`: su nombre se valida con `CRAWLER_USER_AGENT` (se escribe tal cual en `robots.txt`). */
const crawlerRule = z.object({ userAgent: z.string().trim().regex(CRAWLER_USER_AGENT, 'Nombre de rastreador no válido (letras, cifras, punto, guion y guion bajo)'), allow: z.boolean() });
const crawlerPolicy = z
  .object({ search: z.array(crawlerRule).max(40), training: z.array(crawlerRule).max(40) })
  .refine((policy) => {
    const names = [...policy.search, ...policy.training].map((rule) => rule.userAgent.toLowerCase());
    return new Set(names).size === names.length;
  }, 'Un rastreador no puede aparecer dos veces');

export interface SettingDefinition<T> {
  schema: z.ZodType<T>;
  /** Variable de entorno de respaldo (Regla 01 §5). La consola siempre tiene prioridad. */
  envFallback?: string;
  defaultValue?: T;
  /** El valor se puede copiar a la auditoría: no es un dato personal ni un texto largo. */
  auditValue: boolean;
}

const def = <T>(schema: z.ZodType<T>, options: Omit<SettingDefinition<T>, 'schema'>): SettingDefinition<T> => ({ schema, ...options });

export const SETTING_DEFINITIONS = {
  'paycomet.merchantCode': def(text(40), { envFallback: 'PAYCOMET_MERCHANT_CODE', auditValue: true }),
  'paycomet.terminalId': def(z.string().trim().regex(/^\d{1,10}$/, 'El terminal es un número'), { envFallback: 'PAYCOMET_TERMINAL_ID', auditValue: true }),
  'paycomet.jetId': def(text(80), { auditValue: true }),
  'paycomet.serverIp': def(ipAddress, { auditValue: true }),
  'email.provider': def(z.enum(['brevo', 'smtp']), { defaultValue: 'brevo', auditValue: true }),
  // Un remitente o un «responder a» puede ser el buzón de una persona: no se copia a la auditoría (que se conserva 6 años).
  'email.fromAddress': def(z.email(), { auditValue: false }),
  'email.fromName': def(text(80), { defaultValue: 'KORUM', auditValue: true }),
  'email.replyTo': def(z.email(), { auditValue: false }),
  'email.smtp.host': def(text(253), { auditValue: true }),
  'email.smtp.port': def(z.number().int().min(1).max(65_535), { auditValue: true }),
  'invoicing.provider': def(text(60), { auditValue: true }),
  'invoicing.issuerNif': def(taxId, { envFallback: 'VERIFACTU_ISSUER_NIF', auditValue: true }),
  'invoicing.issuerName': def(text(), { envFallback: 'VERIFACTU_ISSUER_NAME', auditValue: true }),
  'invoicing.series': def(z.string().regex(/^[A-Z0-9]{1,10}$/, 'Serie en mayúsculas y cifras'), { auditValue: true }),
  /** Horas que deben pasar desde el sorteo normal antes de poder sustituir un **premio sin reclamar** (Sprint 4.7). 0 = sin espera. Lo fija el abogado (CUMPLIMIENTO §9); el reembolso de un ganador no espera. */
  'raffle.extraRoundMinHours': def(z.number().int().min(0).max(720), { defaultValue: 0, auditValue: true }),
  'hucha.mode': def(z.enum(['DISABLED', 'PLEDGE', 'REGULATED_WALLET']), { defaultValue: 'PLEDGE', auditValue: true }),
  'hucha.walletProvider': def(text(60), { auditValue: true }),
  'autoBoost.publicDisclosureDefault': def(z.enum(['SHOW', 'HIDE']), { defaultValue: 'SHOW', auditValue: true }),
  'seo.aiCrawlers': def(crawlerPolicy, { auditValue: false }),
  'seo.verification.google': def(z.string().trim().regex(SEARCH_VERIFICATION_TOKEN, 'El código de verificación solo lleva letras, cifras, guion y guion bajo (8 a 200)'), { auditValue: true }),
  'seo.verification.bing': def(z.string().trim().regex(SEARCH_VERIFICATION_TOKEN, 'El código de verificación solo lleva letras, cifras, guion y guion bajo (8 a 200)'), { auditValue: true }),
  'platform.company': def(company, { auditValue: false }),
  'pricing.acknowledgements': def(z.array(acknowledgement), { defaultValue: [], auditValue: false }),
  'privacy.policyVersion': def(z.string().regex(LEGAL_VERSION_PATTERN), { defaultValue: '2026-11-01', auditValue: true })
} satisfies Record<string, SettingDefinition<unknown>>;

export { LEGAL_DOCUMENTS, LEGAL_LOCALES };
export type { LegalDocument, LegalLocale };
export type LegalText = z.infer<typeof legalText>;

/** Límites de intentos editables (`limits.gatePinMaxFailures`, `limits.otpMaxAttempts`…). Enteros positivos, nunca 0: un 0 bloquearía el servicio. */
const LIMIT_KEY = /^limits\.[a-z][A-Za-z0-9]{2,60}$/;
const LEGAL_KEY = new RegExp(`^legal\\.(${LEGAL_DOCUMENTS.join('|')})\\.(${LEGAL_LOCALES.join('|')})$`);

type ExactSettingKey = keyof typeof SETTING_DEFINITIONS;
export type LegalSettingKey = `legal.${LegalDocument}.${LegalLocale}`;
export type LimitSettingKey = `limits.${string}`;
export type SettingKey = ExactSettingKey | LegalSettingKey | LimitSettingKey;
export type SettingValue<K extends SettingKey> = K extends ExactSettingKey
  ? z.infer<(typeof SETTING_DEFINITIONS)[K]['schema']>
  : K extends LegalSettingKey
    ? LegalText
    : number;

const LIMIT_DEFINITION = def(z.number().int().min(1).max(1_000_000), { auditValue: true });
const LEGAL_DEFINITION = def(legalText, { auditValue: false });

export class UnknownSettingError extends Error {
  constructor(readonly key: string) {
    super(`El ajuste «${key}» no existe en el catálogo de la consola`);
    this.name = 'UnknownSettingError';
  }
}

export function settingDefinition(key: string): SettingDefinition<unknown> {
  if (Object.hasOwn(SETTING_DEFINITIONS, key)) return SETTING_DEFINITIONS[key as ExactSettingKey] as SettingDefinition<unknown>;
  if (LEGAL_KEY.test(key)) return LEGAL_DEFINITION as SettingDefinition<unknown>;
  if (LIMIT_KEY.test(key)) return LIMIT_DEFINITION as SettingDefinition<unknown>;
  throw new UnknownSettingError(key);
}

/** Secretos de la consola: se guardan cifrados en `PlatformSecret` y nunca se devuelven completos a la pantalla. */
export const SECRET_DEFINITIONS = {
  'paycomet.apiKey': { envFallback: 'PAYCOMET_API_KEY', minLength: 16 },
  'paycomet.webhookSecret': { envFallback: 'PAYCOMET_WEBHOOK_SECRET', minLength: 8 },
  'email.apiKey': { envFallback: 'EMAIL_API_KEY', minLength: 16 },
  'email.smtp.password': { minLength: 8 },
  'invoicing.apiKey': { minLength: 16 },
  'hucha.walletApiKey': { minLength: 16 },
  // IndexNow exige 8 a 128 letras, cifras o guiones: la clave se publica tal cual en `/indexnow-key.txt` (Sprint 5.5b).
  'seo.indexNowKey': { minLength: 8, pattern: /^[A-Za-z0-9-]{8,128}$/, patternMessage: 'La clave de IndexNow lleva de 8 a 128 letras, cifras o guiones' }
} as const satisfies Record<string, SecretDefinition>;

export interface SecretDefinition {
  envFallback?: string;
  minLength: number;
  /** Formato obligatorio, si el proveedor lo fija. */
  pattern?: RegExp;
  patternMessage?: string;
}

export type SecretKey = keyof typeof SECRET_DEFINITIONS;

export function secretDefinition(key: string): SecretDefinition {
  if (!Object.hasOwn(SECRET_DEFINITIONS, key)) throw new UnknownSettingError(key);
  return SECRET_DEFINITIONS[key as SecretKey];
}

export const isSecretKey = (key: string): key is SecretKey => Object.hasOwn(SECRET_DEFINITIONS, key);
