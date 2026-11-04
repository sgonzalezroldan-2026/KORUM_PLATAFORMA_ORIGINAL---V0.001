import { isIP } from 'node:net';
import { z } from 'zod';
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
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/, 'La versión es la fecha de publicación (AAAA-MM-DD, con «.n» si hay varias el mismo día)'),
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
const crawlerPolicy = z.object({ search: z.array(z.object({ userAgent: text(100), allow: z.boolean() })), training: z.array(z.object({ userAgent: text(100), allow: z.boolean() })) });

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
  'email.fromAddress': def(z.email(), { auditValue: true }),
  'email.fromName': def(text(80), { defaultValue: 'KORUM', auditValue: true }),
  'email.replyTo': def(z.email(), { auditValue: true }),
  'email.smtp.host': def(text(253), { auditValue: true }),
  'email.smtp.port': def(z.number().int().min(1).max(65_535), { auditValue: true }),
  'invoicing.provider': def(text(60), { auditValue: true }),
  'invoicing.issuerNif': def(taxId, { envFallback: 'VERIFACTU_ISSUER_NIF', auditValue: true }),
  'invoicing.issuerName': def(text(), { auditValue: true }),
  'invoicing.series': def(z.string().regex(/^[A-Z0-9]{1,10}$/, 'Serie en mayúsculas y cifras'), { auditValue: true }),
  'hucha.mode': def(z.enum(['DISABLED', 'PLEDGE', 'REGULATED_WALLET']), { defaultValue: 'PLEDGE', auditValue: true }),
  'hucha.walletProvider': def(text(60), { auditValue: true }),
  'autoBoost.publicDisclosureDefault': def(z.enum(['SHOW', 'HIDE']), { defaultValue: 'SHOW', auditValue: true }),
  'seo.aiCrawlers': def(crawlerPolicy, { auditValue: false }),
  'seo.verification.google': def(text(200), { auditValue: true }),
  'seo.verification.bing': def(text(200), { auditValue: true }),
  'platform.company': def(company, { auditValue: false }),
  'pricing.acknowledgements': def(z.array(acknowledgement), { defaultValue: [], auditValue: false }),
  'privacy.policyVersion': def(z.string().regex(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/), { auditValue: true })
} satisfies Record<string, SettingDefinition<unknown>>;

export const LEGAL_DOCUMENTS = ['terminos', 'privacidad', 'cookies', 'aviso-legal'] as const;
export const LEGAL_LOCALES = ['es', 'ca', 'en'] as const;
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];
export type LegalLocale = (typeof LEGAL_LOCALES)[number];
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
  'seo.indexNowKey': { minLength: 8 }
} as const satisfies Record<string, { envFallback?: string; minLength: number }>;

export type SecretKey = keyof typeof SECRET_DEFINITIONS;

export function secretDefinition(key: string): { envFallback?: string; minLength: number } {
  if (!Object.hasOwn(SECRET_DEFINITIONS, key)) throw new UnknownSettingError(key);
  return SECRET_DEFINITIONS[key as SecretKey];
}

export const isSecretKey = (key: string): key is SecretKey => Object.hasOwn(SECRET_DEFINITIONS, key);
