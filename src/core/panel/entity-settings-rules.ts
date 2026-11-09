import { z } from 'zod';
import { DONATION_MAX_CENTS, DONATION_MIN_CENTS } from '@/core/checkout/checkout-limits';
import { LINK_LIKE } from '@/core/onboarding/registration-rules';
import { validateTaxId } from '@/core/tax/tax-id';

/**
 * Reglas de los ajustes de la entidad y de sus documentos del titular (Sprint 4.2c, `sch-sub-moderation`). Funciones puras, sin nada de
 * servidor: el formulario las usa para avisar campo a campo y el servidor las vuelve a aplicar antes de guardar.
 *
 * - **KYB:** cuatro documentos siempre (CIF, estatutos o acta, DNI de quien representa y certificado de titularidad de la cuenta de la entidad)
 *   y la acreditación de la Ley 49/2002 si la entidad la declara (ARQUITECTURA_LANDING §3). Mientras KORUM los revisa (`SUBMITTED`) o ya los ha
 *   verificado (`VERIFIED`) no se cambian desde el panel: un documento verificado que cambiase dejaría de estar verificado sin que nadie lo
 *   supiera. Se corrigen con la entidad en `PENDING` o tras una devolución (`REJECTED`).
 * - **Importes:** en euros enteros en el formulario y en céntimos en la base (Regla 01 §2). Tres botones de donación y tres niveles de
 *   patrocinio, de menor a mayor y sin repetir.
 */

export const KYB_DOCUMENT_KINDS = ['TAX_ID_CARD', 'STATUTES', 'REPRESENTATIVE_ID', 'ACCOUNT_OWNERSHIP', 'LEY49_ACCREDITATION'] as const;
export type KybDocumentKind = (typeof KYB_DOCUMENT_KINDS)[number];

export const KYB_STATUSES = ['PENDING', 'SUBMITTED', 'VERIFIED', 'REJECTED'] as const;
export type KybStatus = (typeof KYB_STATUSES)[number];

/** Documentos que la entidad tiene que aportar: los cuatro de siempre y, si declara la Ley 49/2002, su acreditación. */
export function requiredKybKinds(ley49: boolean): KybDocumentKind[] {
  return KYB_DOCUMENT_KINDS.filter((kind) => kind !== 'LEY49_ACCREDITATION' || ley49);
}

/** Los documentos y los datos del titular solo se cambian desde el panel antes de enviarlos o tras una devolución. */
export const canEditKyb = (status: string): boolean => status === 'PENDING' || status === 'REJECTED';

export interface KybReadiness {
  /** Tipos que faltan, en el orden de la lista. */
  missing: KybDocumentKind[];
  /** Falta el CIF del titular (sin él no se puede verificar a quién se paga). */
  missingTaxId: boolean;
  ready: boolean;
}

/** ¿Se puede enviar a revisión? Todos los documentos que tocan y el CIF del titular. */
export function kybReadiness(input: { ley49: boolean; cif: string | null; currentKinds: readonly string[] }): KybReadiness {
  const present = new Set(input.currentKinds);
  const missing = requiredKybKinds(input.ley49).filter((kind) => !present.has(kind));
  const missingTaxId = !input.cif;
  return { missing, missingTaxId, ready: missing.length === 0 && !missingTaxId };
}

/** Plazo legal de un documento KYB (CUMPLIMIENTO §6): mientras dure la relación + 6 años. Se cuenta desde que deja de ser el vigente. */
export const KYB_RETENTION_YEARS = 6;

export function kybRetainUntil(from: Date): Date {
  const until = new Date(from.getTime());
  until.setUTCFullYear(until.getUTCFullYear() + KYB_RETENTION_YEARS);
  return until;
}

// --- Datos del titular -------------------------------------------------------------------------------------------------------------------

const plainText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !LINK_LIKE.test(value));

/** Razón social y CIF del titular. El CIF tiene que ser el de una persona jurídica (con su dígito de control), no un DNI. */
export const kybIdentitySchema = z.object({
  legalName: plainText(3, 120),
  cif: z
    .string()
    .max(20)
    .transform((value, context) => {
      const result = validateTaxId(value);
      if (!result.valid || result.kind !== 'CIF') {
        context.addIssue({ code: 'custom', message: 'CIF no válido' });
        return z.NEVER;
      }
      return result.normalized;
    })
});

export type KybIdentityInput = z.infer<typeof kybIdentitySchema>;

// --- Ajustes generales -------------------------------------------------------------------------------------------------------------------

export const SETTINGS_LIMITS = {
  donationMinEuros: DONATION_MIN_CENTS / 100,
  donationMaxEuros: DONATION_MAX_CENTS / 100,
  minVotesMin: 5,
  minVotesMax: 1000,
  ideaDaysMin: 7,
  ideaDaysMax: 90,
  sponsorMinEuros: 50,
  sponsorMaxEuros: 5000
} as const;

/** Teléfono limpio: sin espacios, puntos, guiones ni paréntesis, con un + delante como mucho. Vacío = sin teléfono. */
export function normalizeEntityPhone(raw: string): string {
  return raw.replace(/[\s.\-()]/g, '');
}

const ascendingTrio = (min: number, max: number) =>
  z
    .tuple([z.number().int().min(min).max(max), z.number().int().min(min).max(max), z.number().int().min(min).max(max)])
    .refine(([a, b, c]) => a < b && b < c, { message: 'De menor a mayor y sin repetir' });

export const entitySettingsSchema = z.object({
  donationPresetsEuros: ascendingTrio(SETTINGS_LIMITS.donationMinEuros, SETTINGS_LIMITS.donationMaxEuros),
  defaultDonationIdx: z.number().int().min(0).max(2),
  minVotes: z.number().int().min(SETTINGS_LIMITS.minVotesMin).max(SETTINGS_LIMITS.minVotesMax),
  maxIdeaDays: z.number().int().min(SETTINGS_LIMITS.ideaDaysMin).max(SETTINGS_LIMITS.ideaDaysMax),
  sponsorTiersEuros: ascendingTrio(SETTINGS_LIMITS.sponsorMinEuros, SETTINGS_LIMITS.sponsorMaxEuros),
  phone: z
    .string()
    .max(30)
    .transform(normalizeEntityPhone)
    .refine((value) => value === '' || /^\+?[0-9]{9,15}$/.test(value)),
  contentLocale: z.enum(['es', 'ca', 'en']),
  publicIndexing: z.boolean()
});

export type EntitySettingsInput = z.input<typeof entitySettingsSchema>;
export type EntitySettings = z.output<typeof entitySettingsSchema>;

/** Campos del formulario con algún error (el primer tramo de la ruta de Zod: `donationPresetsEuros`, `phone`…), para señalarlos a la vez. */
export function settingsFieldIssues(raw: unknown): string[] {
  const parsed = entitySettingsSchema.safeParse(raw);
  return parsed.success ? [] : [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'form')))];
}

/** Lo que se guarda en la entidad, en céntimos. */
export function settingsToColumns(settings: EntitySettings) {
  return {
    donationPresetsCents: settings.donationPresetsEuros.map((euros) => euros * 100),
    defaultDonationIdx: settings.defaultDonationIdx,
    minVotes: settings.minVotes,
    maxIdeaDays: settings.maxIdeaDays,
    sponsorTiersCents: settings.sponsorTiersEuros.map((euros) => euros * 100),
    phone: settings.phone === '' ? null : settings.phone,
    contentLocale: settings.contentLocale,
    publicIndexing: settings.publicIndexing
  };
}

/**
 * Valores del formulario a partir de la entidad. Un importe guardado con céntimos (la semilla o un ajuste antiguo) se redondea al euro hacia
 * arriba solo para enseñarlo: no se cambia hasta que alguien guarda.
 */
export function settingsFromColumns(organization: {
  donationPresetsCents: number[];
  defaultDonationIdx: number;
  minVotes: number;
  maxIdeaDays: number;
  sponsorTiersCents: number[];
  phone: string | null;
  contentLocale: string;
  publicIndexing: boolean;
}): EntitySettingsInput {
  const trio = (cents: number[], fallback: [number, number, number]): [number, number, number] => {
    const euros = cents.slice(0, 3).map((value) => Math.ceil(value / 100));
    return euros.length === 3 ? [euros[0]!, euros[1]!, euros[2]!] : fallback;
  };
  return {
    donationPresetsEuros: trio(organization.donationPresetsCents, [10, 25, 50]),
    defaultDonationIdx: Math.min(2, Math.max(0, organization.defaultDonationIdx)),
    minVotes: organization.minVotes,
    maxIdeaDays: organization.maxIdeaDays,
    sponsorTiersEuros: trio([...organization.sponsorTiersCents].sort((a, b) => a - b), [100, 250, 500]),
    phone: organization.phone ?? '',
    contentLocale: organization.contentLocale === 'ca' || organization.contentLocale === 'en' ? organization.contentLocale : 'es',
    publicIndexing: organization.publicIndexing
  };
}
